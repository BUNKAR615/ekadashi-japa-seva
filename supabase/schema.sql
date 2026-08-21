-- ============================================================
--  Ekadashi Japa Seva — Supabase schema
--  Run this once in the Supabase SQL Editor (Database > SQL Editor).
--  Safe to re-run: every statement is guarded.
-- ============================================================

-- ---------- Devotee IDs (HKMM001, HKMM002, …) ----------
create sequence if not exists public.devotee_seq start 1;

-- ---------- Tables ----------

create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  name        text not null,
  devotee_id  text unique,
  phone       text,
  group_name  text default 'Marwad Youth Bhakti Vriksha',
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  event_date  date not null,
  status      text not null default 'upcoming'
              check (status in ('draft', 'upcoming', 'active', 'closed')),
  starts_at   text not null default '00:00',
  ends_at     text not null default '23:59',
  goal_rounds integer not null default 3000 check (goal_rounds > 0),
  visibility  text not null default 'names'
              check (visibility in ('names', 'ids', 'admin')),
  description text default '',
  created_at  timestamptz not null default now()
);

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
-- individual rows are hidden ('admin' visibility). Returns only aggregates,
-- never a devotee's individual figure.
create or replace function public.event_totals(p_event uuid)
returns table (total bigint, participants bigint, average numeric, highest integer)
language sql
security definer
stable
set search_path = public
as $$
  select
    coalesce(sum(rounds), 0)::bigint,
    count(*)::bigint,
    coalesce(round(avg(rounds)::numeric, 1), 0),
    coalesce(max(rounds), 0)
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

-- This is what makes the "Admin only" privacy setting real: when an event is
-- set to 'admin' visibility, other devotees' rows are not merely hidden in the
-- interface, the database refuses to return them.
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

-- Rounds may only be recorded while the event is actually live.
create policy submissions_insert_own on public.submissions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'active')
  );

create policy submissions_update_own on public.submissions
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.events e where e.id = event_id and e.status = 'active')
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

-- ---------- Seed: a first event ----------
insert into public.events (name, event_date, status, goal_rounds, visibility, description)
select 'Ekadashi Japa Seva', current_date, 'active', 3000, 'names',
       'Offer your chanting with devotion. Rounds can be updated until midnight.'
where not exists (select 1 from public.events);

-- ============================================================
--  AFTER RUNNING THIS: make yourself an admin.
--  Sign up in the app first, then run:
--
--    update public.profiles set is_admin = true
--    where id = (select id from auth.users where email = 'you@example.com');
-- ============================================================
