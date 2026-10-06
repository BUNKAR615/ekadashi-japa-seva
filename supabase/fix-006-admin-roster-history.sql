-- ============================================================
--  FIX 006 — admin sign-in, the whole roster, and devotee history
--
--  RUN THIS ONCE in the Supabase SQL Editor, after fix-003 (and
--  fix-005 if you use it). Safe to re-run, and safe on a project that
--  is already up to date.
--
--  It stands on its own: it carries everything fix-004 did, because
--  the live project never had fix-004 applied — which is what left
--  an account without a profile row stuck at sign-in with "Your
--  devotee profile is still being set up", and nothing on the
--  database able to repair it.
--
--  WHAT IT DOES
--  ------------
--   1. Every account gets exactly one profile, keyed on its auth id.
--   2. ensure_profile() — the app's backstop at sign-in.
--   3. The admin flag is re-derived from the address, so the admin
--      account is recognised as admin again.
--   4. The admin devotee directory carries the email address and the
--      registration date — the address is what tells two devotees of
--      the same name apart.
--   5. claim_account() (fix-005), if installed, refuses the admin
--      address. Anyone could otherwise replace the admin's password
--      by typing that address into Create Account, and every one of
--      the admin's sessions was deleted when they did.
--   6. An index for reading one devotee's history across challenges.
--
--  Nothing is deleted. No round, submission or challenge is changed.
-- ============================================================


-- ============================================================
--  1. EVERY ACCOUNT HAS EXACTLY ONE PROFILE
-- ============================================================

create sequence if not exists public.devotee_seq start 1;

-- Keep the devotee-number counter ahead of every ID already issued,
-- or the backfill below could collide with an existing HKMM number.
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
  end if;
end $$;

-- Accounts made before the signup trigger existed, or where it failed.
-- Matched on the auth id, so an account that has a profile is untouched.
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

update public.profiles
   set devotee_id = 'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
 where devotee_id is null;

-- The signup trigger, re-asserted in its current form.
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


-- ============================================================
--  2. ensure_profile() — the app's backstop at sign-in
--
--  Works on auth.uid() alone, so a devotee can only create or rename
--  their OWN profile. It writes `name` and nothing else.
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

  -- ON CONFLICT is avoided: the OUT parameters share the column names
  -- and plpgsql would read the conflict target as one of them.
  begin
    insert into public.profiles (id, name, devotee_id)
    select v_uid,
           coalesce(v_name, nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'Devotee'),
           'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
    where not exists (select 1 from public.profiles p2 where p2.id = v_uid);
  exception when unique_violation then
    null;   -- a concurrent signup created it first; that row stands
  end;

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
--  3. THE ADMIN IS RECOGNISED BY ADDRESS
--
--  The enforce_admin_email trigger sets the flag on every write; this
--  re-derives it for every existing row in case one was written while
--  the trigger was missing.
-- ============================================================

update public.profiles p
   set is_admin = (lower(coalesce((select u.email from auth.users u where u.id = p.id), ''))
                   = lower(public.admin_email()))
 where p.is_admin is distinct from
       (lower(coalesce((select u.email from auth.users u where u.id = p.id), ''))
        = lower(public.admin_email()));


-- ============================================================
--  4. ADMIN DIRECTORY — with the address and registration date
--
--  Returns nothing at all unless the caller is the admin.
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
--  5. claim_account() NEVER TOUCHES THE ADMIN
--
--  Only redefined if fix-005 installed it; this file never installs
--  it on a project that chose not to have it. For the admin address
--  it changes nothing and answers {"found": true, "protected": true},
--  and the app sends the admin to the emailed reset link instead.
-- ============================================================

do $outer$
begin
  if to_regprocedure('public.claim_account(text,text,text)') is null then
    raise notice 'claim_account() is not installed — nothing to protect.';
    return;
  end if;

  execute $fn$
    create or replace function public.claim_account(
      p_email    text,
      p_password text,
      p_name     text default null
    )
    returns json
    language plpgsql
    security definer
    set search_path = public, extensions
    as $body$
    declare
      v_id    uuid;
      v_email text := lower(btrim(coalesce(p_email, '')));
      v_name  text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
    begin
      if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        raise exception 'Please enter a valid email address.' using errcode = '22023';
      end if;

      if length(coalesce(p_password, '')) < 6 then
        raise exception 'Password must be at least 6 characters.' using errcode = '22023';
      end if;

      select u.id into v_id
      from auth.users u
      where lower(u.email) = v_email
        and u.deleted_at is null
      order by u.created_at
      limit 1;

      if v_id is null then
        return json_build_object('found', false);
      end if;

      -- The admin account is never taken over this way. Its password
      -- changes only through the emailed reset link.
      if v_email = lower(public.admin_email()) then
        return json_build_object('found', true, 'protected', true);
      end if;

      update auth.users
         set encrypted_password = crypt(p_password, gen_salt('bf', 10)),
             email_confirmed_at = coalesce(email_confirmed_at, now()),
             raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                                  || case when v_name is null then '{}'::jsonb
                                          else jsonb_build_object('name', v_name) end,
             updated_at = now()
       where id = v_id;

      begin
        if to_regclass('auth.refresh_tokens') is not null then
          delete from auth.refresh_tokens where user_id = v_id::text;
        end if;
        if to_regclass('auth.sessions') is not null then
          delete from auth.sessions where user_id = v_id;
        end if;
      exception when others then
        null;
      end;

      if exists (select 1 from public.profiles p where p.id = v_id) then
        update public.profiles p
           set name = coalesce(v_name, p.name)
         where p.id = v_id;
      else
        insert into public.profiles (id, name, devotee_id)
        select v_id,
               coalesce(v_name, nullif(split_part(v_email, '@', 1), ''), 'Devotee'),
               'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
        where not exists (select 1 from public.profiles p2 where p2.id = v_id);
      end if;

      return json_build_object('found', true, 'user_id', v_id);
    end;
    $body$;
  $fn$;

  execute 'revoke all on function public.claim_account(text, text, text) from public';
  execute 'grant execute on function public.claim_account(text, text, text) to anon, authenticated';
  raise notice 'claim_account() now refuses the admin address.';
end
$outer$;


-- ============================================================
--  6. HISTORY — one devotee across every challenge
--
--  Submissions already hold one row per (challenge, devotee), kept
--  when a new challenge starts. This index makes reading one
--  devotee's rows quick; the admin reads them through the existing
--  submissions_admin_all policy.
-- ============================================================

create index if not exists submissions_user_idx on public.submissions (user_id);


-- ============================================================
--  REPORT — every row should say PASS
-- ============================================================

with
  admin as (
    select u.id from auth.users u where lower(u.email) = lower(public.admin_email())
  ),
  checks as (
    select 1 as n, 'Admin account exists' as item,
      case when exists (select 1 from admin) then 'PASS' else 'FAIL' end as status,
      public.admin_email() as detail
    union all select 2, 'Admin has a profile flagged admin',
      case when exists (select 1 from public.profiles p join admin a on a.id = p.id where p.is_admin)
           then 'PASS' else 'FAIL' end,
      coalesce((select p.name || ' · ' || p.devotee_id from public.profiles p join admin a on a.id = p.id), 'no profile')
    union all select 3, 'Exactly one admin',
      case when (select count(*) from public.profiles where is_admin) = 1 then 'PASS' else 'FAIL' end,
      (select count(*) || ' admin profile(s)' from public.profiles where is_admin)
    union all select 4, 'Every account has a profile',
      case when not exists (select 1 from auth.users u left join public.profiles p on p.id = u.id where p.id is null)
           then 'PASS' else 'FAIL' end,
      (select count(*) || ' account(s), ' from auth.users) || (select count(*) || ' profile(s)' from public.profiles)
    union all select 5, 'One account per email address',
      case when not exists (select 1 from auth.users where email is not null and email <> ''
                            group by lower(email) having count(*) > 1)
           then 'PASS' else 'FAIL' end,
      'auth.users enforces it; checked here too'
    union all select 6, 'ensure_profile() installed',
      case when to_regprocedure('public.ensure_profile(text)') is not null then 'PASS' else 'FAIL' end, ''
    union all select 7, 'Directory carries the address',
      case when pg_get_function_result(to_regprocedure('public.admin_devotees()')) like '%email%' then 'PASS' else 'FAIL' end, ''
    union all select 8, 'One entry per devotee per challenge',
      case when not exists (select 1 from public.submissions group by event_id, user_id having count(*) > 1)
           then 'PASS' else 'FAIL' end,
      (select count(*) || ' entr(ies) across ' || count(distinct event_id) || ' challenge(s)' from public.submissions)
    union all select 9, 'Admin rounds history',
      'INFO',
      (select count(*) || ' entr(ies), ' || coalesce(sum(rounds), 0) || ' rounds'
       from public.submissions where user_id = (select id from admin))
  )
select status, item, detail from checks order by n;
