-- ============================================================
--  Ekadashi Japa Seva — Supabase schema
--  Run this once in the Supabase SQL Editor (Database > SQL Editor).
--  Safe to re-run: every statement is guarded.
--  (Existing projects created before challenge management should run
--   fix-002-challenges.sql instead of re-running this file.)
-- ============================================================

-- ---------- Devotee IDs (HKMM001, HKMM002, …) ----------
create sequence if not exists public.devotee_seq start 1;

-- ---------- Tables ----------

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text not null,
  devotee_id  text unique,
  phone       text,
  group_name  text default 'Jodhpur Folk',
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- A challenge is one continuous window: it opens at start_at and
  -- closes at end_at. It does not repeat daily.
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  status      text not null default 'upcoming'
              check (status in ('draft', 'upcoming', 'active', 'closed')),
  goal_rounds integer not null default 3000 check (goal_rounds > 0),
  visibility  text not null default 'names'
              check (visibility in ('names', 'ids', 'admin', 'off')),
  description text default '',
  created_at  timestamptz not null default now(),
  constraint events_window_check check (end_at >= start_at)
);

-- One running total per devotee per challenge, editable while the
-- challenge window is open.
create table if not exists public.submissions (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  rounds     integer not null check (rounds >= 0 and rounds <= 216),
  updated_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create index if not exists submissions_event_idx on public.submissions (event_id);
create index if not exists events_status_idx     on public.events (status);
create index if not exists events_window_idx     on public.events (start_at, end_at);

-- A revision always stamps the moment it happened, even if a client
-- ever forgets to send it.
create or replace function public.touch_submission()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists submissions_touch on public.submissions;
create trigger submissions_touch
  before insert or update on public.submissions
  for each row execute function public.touch_submission();

-- Only one event may be live at a time.
create unique index if not exists events_single_active_idx
  on public.events ((status)) where status = 'active';

-- ---------- Helper: am I an admin? ----------
-- SECURITY DEFINER so policies can call it without recursing into
-- the profiles policies (which would deadlock RLS).
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------- New signups get a profile automatically ----------
-- Admin status is not set here; it is derived from the account's email
-- by the enforce_admin_email trigger further down.
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
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
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

-- ---------- Aggregates ----------
-- SECURITY DEFINER so the group total stays correct even for events whose
-- individual rows are hidden ('admin' or 'off' visibility). Returns only
-- aggregates, never a devotee's individual figure.
drop function if exists public.event_totals(uuid);
create function public.event_totals(p_event uuid)
returns table (total bigint, participants bigint, average numeric, highest bigint)
language sql
security definer
stable
set search_path = public
as $$
  select
    coalesce(sum(rounds), 0)::bigint,
    count(*)::bigint,
    coalesce(round(avg(rounds), 1), 0),
    coalesce(max(rounds), 0)::bigint
  from public.submissions
  where event_id = p_event and rounds > 0;
$$;

-- Admin-only devotee directory (includes email addresses and phone
-- numbers). Two devotees may share a name; the address is what tells
-- their accounts apart, so it is listed here. The body returns nothing
-- at all unless the caller is the admin.
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

-- ---------- Every account has exactly one profile ----------
-- The profile is normally made by handle_new_user above. This is the
-- backstop the app calls when it signs a devotee in and finds none —
-- and what saves a corrected name after an account recovery.
--
-- It works on auth.uid() alone, so a devotee can only create or rename
-- their OWN profile, and it can never make a second row for an account
-- because the profile's primary key IS the auth id. It writes `name`
-- and nothing else: rounds, history, devotee_id and is_admin are left
-- exactly as they were, which is what makes recovery safe.
drop function if exists public.ensure_profile(text);
create function public.ensure_profile(p_name text default null)
returns table (
  id uuid, name text, devotee_id text, group_name text, is_admin boolean
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

-- ---------- Admin is pinned to one email ----------
-- Exactly one account is a temple admin: the address returned by
-- admin_email(). Everyone else is an ordinary user, always. A trigger
-- re-derives is_admin from the account's email on every insert and
-- update, so the flag cannot drift — not from the app, not from RLS,
-- not from a stray SQL update. To hand the role over, change the
-- address inside admin_email().
create or replace function public.admin_email()
returns text
language sql
immutable
as $$ select 'dineshbunkar533@gmail.com'::text $$;

create or replace function public.enforce_admin_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select u.email into v_email from auth.users u where u.id = new.id;
  new.is_admin := (lower(coalesce(v_email, '')) = lower(public.admin_email()));
  return new;
end;
$$;

drop trigger if exists profiles_enforce_admin on public.profiles;
create trigger profiles_enforce_admin
  before insert or update on public.profiles
  for each row execute function public.enforce_admin_email();

-- ---------- Row Level Security ----------

alter table public.profiles    enable row level security;
alter table public.events      enable row level security;
alter table public.submissions enable row level security;

-- profiles ---------------------------------------------------
drop policy if exists profiles_read        on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_admin_all   on public.profiles;

-- Names are readable by signed-in devotees so the leaderboard can show them.
-- Phone numbers are withheld by the column grants further down.
create policy profiles_read on public.profiles
  for select to authenticated using (true);

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- events -----------------------------------------------------
drop policy if exists events_read      on public.events;
drop policy if exists events_admin_all on public.events;

create policy events_read on public.events
  for select to authenticated using (true);

create policy events_admin_all on public.events
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- submissions ------------------------------------------------
drop policy if exists submissions_read       on public.submissions;
drop policy if exists submissions_insert_own on public.submissions;
drop policy if exists submissions_update_own on public.submissions;
drop policy if exists submissions_admin_all  on public.submissions;

-- This is what makes the leaderboard privacy settings real: for 'admin'
-- and 'off' events, other devotees' rows are not merely hidden in the
-- interface — the database refuses to return them.
create policy submissions_read on public.submissions
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.events e
      where e.id = submissions.event_id
        and e.visibility in ('names', 'ids')
    )
  );

-- Rounds may only be recorded while the challenge window is genuinely
-- open — published, started, and not yet ended.
create policy submissions_insert_own on public.submissions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_id and e.status = 'active'
        and now() >= e.start_at and now() <= e.end_at
    )
  );

create policy submissions_update_own on public.submissions
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_id and e.status = 'active'
        and now() >= e.start_at and now() <= e.end_at
    )
  );

create policy submissions_admin_all on public.submissions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- Column grants ----------
-- Supabase grants blanket privileges on public tables to `authenticated`.
-- Those must be REVOKED before the column-scoped grants below mean anything —
-- otherwise a devotee could edit any column of their own profile row,
-- including is_admin, and promote themselves.
revoke select, update, insert, delete on public.profiles from authenticated;

-- Phone numbers are withheld from ordinary devotees; admins read them
-- through admin_devotees() instead.
grant select (id, name, devotee_id, group_name, is_admin, created_at)
  on public.profiles to authenticated;
grant update (name, phone, group_name) on public.profiles to authenticated;

-- Reads and writes on the two data tables are shaped by the policies
-- above, so the table grants stay whole.
grant select, insert, update, delete on public.events      to authenticated;
grant select, insert, update, delete on public.submissions to authenticated;

grant execute on function public.event_totals(uuid) to authenticated;
grant execute on function public.admin_devotees() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_email() to authenticated;

revoke all on function public.ensure_profile(text) from public, anon;
grant execute on function public.ensure_profile(text) to authenticated;

-- ---------- Seed: a first event ----------
insert into public.events (name, start_at, end_at, status, goal_rounds, visibility, description)
select 'Ekadashi Japa Seva',
       date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata',
       (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day' - interval '1 minute') at time zone 'Asia/Kolkata',
       'active', 3000, 'names',
       'Offer your chanting with devotion.'
where not exists (select 1 from public.events);

-- ============================================================
--  Admin access belongs to exactly one address, set in
--  admin_email() above. That account is a full participant too:
--  it records rounds and appears on the leaderboard like everyone
--  else, and additionally sees the Admin tab. Every other account
--  is an ordinary user and cannot be promoted from inside the app.
-- ============================================================
