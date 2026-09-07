-- ============================================================
--  FIX 004 — accounts: one devotee per email address
--
--  RUN THIS ONCE in the Supabase SQL Editor (Database > SQL Editor),
--  after fix-003-persistence.sql. Safe to re-run, and safe on a
--  project that is already up to date.
--
--  WHAT IT IS FOR
--  --------------
--  The email address is the account. Everything a devotee has ever
--  offered hangs off their auth id, and that id never changes — not
--  when they forget their password, not when they come back and type
--  their details in again. So recovering an address keeps every round,
--  every challenge and the devotee ID attached to it.
--
--  Names are NOT identifying. Three devotees called Dinesh with three
--  addresses are three accounts, and nothing here treats them as one.
--
--  Uniqueness of the address itself is already guaranteed by Supabase:
--  auth.users has a unique index on the (lower-cased) email, so a
--  second signup for a registered address is refused by the auth
--  service before it reaches this schema. This file makes the profile
--  side of that guarantee just as solid:
--
--    1. every account has exactly one profile row, keyed on its auth
--       id — created on signup, repaired here if it ever went missing;
--    2. ensure_profile() lets a signed-in devotee heal their own
--       missing profile instead of being told to try again later;
--    3. the admin devotee directory shows the address, so the temple
--       can tell two devotees of the same name apart.
--
--  Nothing is deleted. No rounds, submissions or challenges are
--  touched by any statement in this file.
-- ============================================================


-- ============================================================
--  1. DEVOTEE IDS — keep the counter ahead of what is already issued
--
--  devotee_id is unique. If the sequence were behind (a restored
--  backup, rows inserted by hand), the backfill in section 2 would
--  collide with an existing HKMM number. Move it past the highest one
--  in use first.
-- ============================================================

create sequence if not exists public.devotee_seq start 1;

do $$
declare
  v_max bigint;
begin
  select coalesce(max((regexp_replace(devotee_id, '\D', '', 'g'))::bigint), 0)
    into v_max
  from public.profiles
  where devotee_id ~ '^HKMM[0-9]+$';

  if v_max > 0 and v_max >= coalesce((select last_value from public.devotee_seq), 0) then
    perform setval('public.devotee_seq', v_max);
    raise notice 'Devotee ID counter moved to %.', v_max;
  end if;
end $$;


-- ============================================================
--  2. EVERY ACCOUNT GETS A PROFILE
--
--  New signups get one from the on_auth_user_created trigger. This
--  backfills accounts made before that trigger existed, or where it
--  failed — the accounts that currently meet "Your devotee profile is
--  still being set up" and can never get past it.
--
--  Matched on the auth id, so an account that already has a profile is
--  left completely alone.
-- ============================================================

insert into public.profiles (id, name, devotee_id)
select
  u.id,
  coalesce(
    nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
    'Devotee'
  ),
  'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;

-- A profile that somehow lost its devotee ID gets one back.
update public.profiles
   set devotee_id = 'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
 where devotee_id is null;


-- ============================================================
--  3. THE SIGNUP TRIGGER
--
--  Re-asserted here so a project that is missing it (or has an older
--  version) ends up with the current one. Admin status is not set
--  here; it is derived from the account's email by the
--  enforce_admin_email trigger in schema.sql.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, devotee_id, phone)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Devotee'
    ),
    'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0'),
    nullif(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admin belongs to the address in admin_email(), and to no other. The
-- profiles just backfilled got the flag from the enforce_admin_email
-- trigger; this re-derives it for the rest, so a row written while that
-- trigger was missing cannot leave the temple without an admin — or with
-- one it did not choose. (fix-003 does this too; repeated here so this
-- file stands on its own.)
do $$
begin
  if exists (select 1 from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'admin_email') then
    update public.profiles p
       set is_admin = (lower(coalesce((select u.email from auth.users u where u.id = p.id), ''))
                       = lower(public.admin_email()))
     where p.is_admin is distinct from
           (lower(coalesce((select u.email from auth.users u where u.id = p.id), ''))
            = lower(public.admin_email()));
    raise notice 'Admin flag re-derived from the account addresses.';
  else
    raise notice 'admin_email() not found — run schema.sql or fix-003 first.';
  end if;
end $$;


-- ============================================================
--  4. ensure_profile() — the app's backstop
--
--  Called by the app when it signs a devotee in and finds no profile
--  row, and after an account recovery to save a corrected name.
--
--  It works on auth.uid() and nothing else, so a devotee can only ever
--  create or rename their OWN profile — the parameter is a name, never
--  an id. It cannot produce a second row for an account: the profile's
--  primary key IS the auth id. And it only ever writes `name`:
--  rounds, submissions, history, devotee_id and is_admin are untouched,
--  which is what makes recovering an account safe.
-- ============================================================

drop function if exists public.ensure_profile(text);

create function public.ensure_profile(p_name text default null)
returns table (
  id         uuid,
  name       text,
  devotee_id text,
  group_name text,
  is_admin   boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_name  text;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;

  v_name := nullif(btrim(coalesce(p_name, '')), '');

  -- Created only if this account has none. ON CONFLICT is deliberately
  -- avoided here: this function's OUT parameters are named after the
  -- columns, and plpgsql would read the conflict target as one of those
  -- variables. The handler covers the race with a concurrent signup.
  begin
    insert into public.profiles (id, name, devotee_id)
    select v_uid,
           coalesce(v_name, nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'Devotee'),
           'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
    where not exists (select 1 from public.profiles p2 where p2.id = v_uid);
  exception when unique_violation then
    null;   -- another connection created it first; that row stands
  end;

  -- A name given on the recovery screen replaces the old one. Nothing
  -- else about the devotee changes.
  update public.profiles p
     set name       = coalesce(v_name, p.name),
         devotee_id = coalesce(p.devotee_id,
                        'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0'))
   where p.id = v_uid;

  return query
    select p.id, p.name, p.devotee_id, p.group_name, p.is_admin
    from public.profiles p
    where p.id = v_uid;
end;
$$;

revoke all on function public.ensure_profile(text) from public, anon;
grant execute on function public.ensure_profile(text) to authenticated;


-- ============================================================
--  5. THE ADMIN DIRECTORY SHOWS THE ADDRESS
--
--  Two devotees may share a name; their addresses are what tell them
--  apart, so the admin list and the CSV export carry the address.
--
--  Still admin-only: the body returns nothing at all unless
--  public.is_admin() is true for the caller, and ordinary devotees
--  cannot read auth.users by any other route.
-- ============================================================

drop function if exists public.admin_devotees();

create function public.admin_devotees()
returns table (
  id uuid, name text, devotee_id text, email text, phone text,
  group_name text, is_admin boolean, created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.name, p.devotee_id, u.email::text, p.phone,
         p.group_name, p.is_admin, p.created_at
  from public.profiles p
  left join auth.users u on u.id = p.id
  where public.is_admin()
  order by p.devotee_id;
$$;

revoke all on function public.admin_devotees() from public, anon;
grant execute on function public.admin_devotees() to authenticated;


-- ============================================================
--  6. REPORT — is every address unique?
--
--  Read the Messages/Notices tab after running this file.
-- ============================================================

do $$
declare
  v_dupes    int;
  v_accounts int;
  v_profiles int;
begin
  select count(*) into v_dupes
  from (
    select lower(email) as e
    from auth.users
    where email is not null and email <> ''
    group by lower(email)
    having count(*) > 1
  ) d;

  select count(*) into v_accounts from auth.users;
  select count(*) into v_profiles from public.profiles;

  raise notice '% account(s), % profile(s).', v_accounts, v_profiles;

  if v_dupes = 0 then
    raise notice 'Every account has its own email address. Nothing to merge.';
  else
    raise warning '% email address(es) appear on more than one account. '
                  'Supabase does not normally allow this — check auth.users.', v_dupes;
  end if;
end $$;


-- ============================================================
--  AFTER RUNNING THIS FILE
--
--  In the Supabase dashboard, under Authentication > URL Configuration,
--  add the address the app is served from to "Redirect URLs" — for the
--  temple's deployment:
--
--      https://japa-seva.vercel.app
--      https://japa-seva.vercel.app/
--      http://localhost:8734          (only if you develop locally)
--
--  Password-reset emails send devotees to that address. Without it the
--  link bounces to the project's Site URL and the reset cannot finish.
--
--  Passwords themselves are never stored here. Supabase Auth hashes
--  them in auth.users, which this schema only ever reads an email
--  address out of.
-- ============================================================
