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
  group_name  text default 'Jodhpur Youth Bhakti Vriksha',
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
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first boolean;
begin
  -- The first devotee to register becomes the temple admin; everyone
  -- after that is an ordinary devotee.
  select not exists (select 1 from public.profiles) into v_first;

  insert into public.profiles (id, name, devotee_id, phone, is_admin)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0'),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    v_first
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

-- Admin-only devotee directory (includes phone numbers).
create or replace function public.admin_devotees()
returns table (
  id uuid, name text, devotee_id text, phone text,
  group_name text, is_admin boolean, created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.name, p.devotee_id, p.phone, p.group_name, p.is_admin, p.created_at
  from public.profiles p
  where public.is_admin()
  order by p.devotee_id;
$$;

-- ---------- Admin role management ----------
-- Promote or demote a devotee. Guarded so at least one admin remains.
create or replace function public.set_admin(p_target uuid, p_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only temple admins can manage admin roles';
  end if;
  if not p_admin then
    if not exists (select 1 from public.profiles where is_admin and id <> p_target) then
      raise exception 'At least one admin must remain';
    end if;
  end if;
  update public.profiles set is_admin = p_admin where id = p_target;
end;
$$;

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

-- Defence in depth: refuse any change to is_admin unless the caller is
-- already an admin, even if the grants above are loosened later.
create or replace function public.guard_profile_admin_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_admin is distinct from old.is_admin and not public.is_admin() then
    raise exception 'Only temple admins can change admin status';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin
  before update on public.profiles
  for each row execute function public.guard_profile_admin_flag();

grant execute on function public.event_totals(uuid) to authenticated;
grant execute on function public.admin_devotees() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.set_admin(uuid, boolean) to authenticated;

-- ---------- Seed: a first event ----------
insert into public.events (name, start_at, end_at, status, goal_rounds, visibility, description)
select 'Ekadashi Japa Seva',
       date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata',
       (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day' - interval '1 minute') at time zone 'Asia/Kolkata',
       'active', 3000, 'names',
       'Offer your chanting with devotion.'
where not exists (select 1 from public.events);

-- ============================================================
--  The first devotee to sign up becomes the temple admin
--  automatically. Admins can promote or demote others from the
--  Devotees tab inside the app.
-- ============================================================
