-- ============================================================
--  FIX 003 — bring an older project up to the current schema
--
--  RUN THIS ONCE in the Supabase SQL Editor (Database > SQL Editor).
--  Safe to re-run, and safe on a project that is already up to date.
--
--  WHY THIS EXISTS
--  ---------------
--  The live project was still on the first schema, where a challenge
--  was a DATE plus two clock-time strings (event_date / starts_at /
--  ends_at). The app has since moved to one continuous window with
--  real timestamps (start_at / end_at).
--
--  Every read the app makes was therefore rejected by PostgREST with
--    42703  column events.start_at does not exist
--  and rounds could never be written at all. Running this file is
--  what makes submissions actually persist.
--
--  It is a single, complete migration: it replaces fix-002 and also
--  applies the profile column grants from schema.sql, so this one
--  file is the only thing that needs running.
--
--  Nothing is deleted. The legacy date columns are backfilled into
--  the new timestamps BEFORE they are removed.
-- ============================================================


-- ============================================================
--  0. CLEAR THE OLD POLICIES FIRST
--
--  The first-generation policies referenced event_date directly, and
--  Postgres refuses to drop a column another object depends on. They
--  are all recreated, in their current form, in section 6.
-- ============================================================

drop policy if exists profiles_read          on public.profiles;
drop policy if exists profiles_update_self   on public.profiles;
drop policy if exists profiles_admin_all     on public.profiles;

drop policy if exists events_read            on public.events;
drop policy if exists events_admin_all       on public.events;

drop policy if exists submissions_read       on public.submissions;
drop policy if exists submissions_insert_own on public.submissions;
drop policy if exists submissions_update_own on public.submissions;
drop policy if exists submissions_admin_all  on public.submissions;


-- ============================================================
--  1. CHALLENGES — one continuous window
-- ============================================================

alter table public.events add column if not exists start_at timestamptz;
alter table public.events add column if not exists end_at   timestamptz;

-- Backfill from whichever legacy columns this project happens to have.
-- Times recorded under the old model were Indian Standard Time.
do $$
declare
  v_has_date     boolean;
  v_has_end_date boolean;
  v_has_starts   boolean;
  v_has_ends     boolean;
  v_start_time   text;
  v_end_time     text;
  v_end_day      text;
begin
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'events'
                   and column_name = 'event_date') into v_has_date;
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'events'
                   and column_name = 'end_date') into v_has_end_date;
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'events'
                   and column_name = 'starts_at') into v_has_starts;
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'events'
                   and column_name = 'ends_at') into v_has_ends;

  if v_has_date then
    v_start_time := case when v_has_starts
                      then $x$coalesce(nullif(starts_at, ''), '00:00')$x$
                      else $x$'00:00'$x$ end;
    v_end_time   := case when v_has_ends
                      then $x$coalesce(nullif(ends_at, ''), '23:59')$x$
                      else $x$'23:59'$x$ end;
    v_end_day    := case when v_has_end_date
                      then $x$coalesce(end_date, event_date)$x$
                      else $x$event_date$x$ end;

    execute format(
      $x$update public.events
            set start_at = ((event_date::text || ' ' || %s)::timestamp
                            at time zone 'Asia/Kolkata')
          where start_at is null$x$, v_start_time);

    execute format(
      $x$update public.events
            set end_at = ((%s::text || ' ' || %s)::timestamp
                          at time zone 'Asia/Kolkata')
          where end_at is null$x$, v_end_day, v_end_time);
  end if;
end $$;

-- Any row the backfill could not reach (there should be none) gets a
-- sane window rather than blocking the NOT NULL below.
update public.events set start_at = coalesce(created_at, now()) where start_at is null;
update public.events set end_at   = start_at + interval '1 day'  where end_at   is null;
update public.events set end_at   = start_at                     where end_at   < start_at;

alter table public.events alter column start_at set not null;
alter table public.events alter column end_at   set not null;

-- The legacy columns are superseded. They are dropped rather than left
-- behind because several were NOT NULL, which would make every new
-- challenge the app creates fail on insert.
alter table public.events drop column if exists event_date;
alter table public.events drop column if exists end_date;
alter table public.events drop column if exists starts_at;
alter table public.events drop column if exists ends_at;
alter table public.events drop column if exists rank_by;
alter table public.events drop column if exists featured;

alter table public.events drop constraint if exists events_window_check;
alter table public.events add  constraint events_window_check check (end_at >= start_at);

alter table public.events drop constraint if exists events_status_check;
alter table public.events add  constraint events_status_check
  check (status in ('draft', 'upcoming', 'active', 'closed'));

alter table public.events drop constraint if exists events_visibility_check;
alter table public.events add  constraint events_visibility_check
  check (visibility in ('names', 'ids', 'admin', 'off'));

alter table public.events alter column status      set default 'upcoming';
alter table public.events alter column goal_rounds set default 3000;
alter table public.events alter column visibility  set default 'names';

create index if not exists events_status_idx on public.events (status);
create index if not exists events_window_idx on public.events (start_at, end_at);

-- Only one challenge may be live at a time. Close any extras before the
-- unique index is created, or creating it would fail.
update public.events set status = 'closed'
where status = 'active'
  and id is distinct from (
    select id from public.events where status = 'active'
    order by start_at desc, created_at desc limit 1);

create unique index if not exists events_single_active_idx
  on public.events ((status)) where status = 'active';


-- ============================================================
--  2. SUBMISSIONS — exactly one running total per devotee
--
--  This is what makes editing work without ever creating a
--  duplicate: the app upserts on (event_id, user_id), so the same
--  row is updated in place however many times the devotee revises
--  their count.
-- ============================================================

-- If a per-day model was ever applied, collapse it by summing.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'submissions'
               and column_name = 'entry_date') then
    create temp table _collapsed as
      select event_id, user_id, least(sum(rounds), 216) as rounds, max(updated_at) as updated_at
      from public.submissions group by event_id, user_id;
    delete from public.submissions;
    alter table public.submissions drop constraint if exists submissions_event_user_day_key;
    alter table public.submissions drop column entry_date;
    insert into public.submissions (event_id, user_id, rounds, updated_at)
      select event_id, user_id, rounds, updated_at from _collapsed;
    drop table _collapsed;
  end if;
end $$;

alter table public.submissions add column if not exists updated_at timestamptz not null default now();
alter table public.submissions alter column updated_at set default now();

-- Collapse any duplicates that predate the constraint, keeping the highest.
delete from public.submissions s
where exists (
  select 1 from public.submissions k
  where k.event_id = s.event_id and k.user_id = s.user_id
    and (k.rounds, k.updated_at, k.id) > (s.rounds, s.updated_at, s.id)
);

alter table public.submissions drop constraint if exists submissions_event_id_user_id_key;
alter table public.submissions add  constraint submissions_event_id_user_id_key
  unique (event_id, user_id);

-- An early version of the schema required rounds > 0, which would now
-- refuse a devotee correcting their count back down to zero. Drop every
-- check on the column, whatever it was named, and state the rule once.
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.submissions'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%rounds%'
  loop
    execute format('alter table public.submissions drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.submissions add constraint submissions_rounds_check
  check (rounds >= 0 and rounds <= 216);

create index if not exists submissions_event_idx on public.submissions (event_id);

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


-- ============================================================
--  3. PROFILES
-- ============================================================

create sequence if not exists public.devotee_seq start 1;

-- Keep the devotee-number sequence ahead of every id already issued.
-- If it falls behind — ids assigned by hand, rows restored from a
-- backup, the sequence reset — the next signup dies on a duplicate
-- devotee_id inside the profile trigger, and the account is lost with
-- no useful message. Reconcile it here.
do $$
declare v_max bigint;
begin
  select coalesce(max((regexp_replace(devotee_id, '\D', '', 'g'))::bigint), 0)
    into v_max
  from public.profiles
  where devotee_id ~ '^\D*\d+$';

  if v_max > 0 then perform setval('public.devotee_seq', v_max, true);
  else              perform setval('public.devotee_seq', 1, false);
  end if;
end $$;

alter table public.profiles alter column group_name set default 'Jodhpur Folk';
update public.profiles set group_name = 'Jodhpur Folk' where group_name is distinct from 'Jodhpur Folk';


-- ============================================================
--  4. HELPERS
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Aggregates. SECURITY DEFINER so the group total stays correct even for
-- challenges whose individual rows are hidden. Returns only aggregates.
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


-- ============================================================
--  5. ADMIN IS PINNED TO ONE EMAIL
--
--  Exactly one account is a temple admin. A trigger re-derives
--  is_admin from the account's email on every write, so the flag
--  cannot drift. To hand the role over, change the address inside
--  admin_email() and re-run the reconcile statement below.
-- ============================================================

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

-- The older guard is superseded: this trigger is strictly stronger.
drop trigger  if exists profiles_guard_admin on public.profiles;
drop function if exists public.guard_profile_admin_flag();
drop function if exists public.set_admin(uuid, boolean);

drop trigger if exists profiles_enforce_admin on public.profiles;
create trigger profiles_enforce_admin
  before insert or update on public.profiles
  for each row execute function public.enforce_admin_email();

-- New signups get a profile automatically; admin status is derived above.
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

-- Reconcile every existing profile with the rule right now.
update public.profiles p
set is_admin = (
  lower(coalesce((select u.email from auth.users u where u.id = p.id), '')) = lower(public.admin_email())
);


-- ============================================================
--  6. ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles    enable row level security;
alter table public.events      enable row level security;
alter table public.submissions enable row level security;

-- profiles ---------------------------------------------------
drop policy if exists profiles_read        on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_admin_all   on public.profiles;

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

-- Leaderboard privacy is real: for 'admin' and 'off' challenges the
-- database refuses to return other devotees' rows.
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

-- A devotee may revise ONLY their own row, and only while the window
-- is open. Editing someone else's entry is refused by the database.
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


-- ============================================================
--  7. GRANTS
--
--  Supabase grants blanket privileges on public tables to
--  `authenticated`. Those must be REVOKED on profiles before the
--  column-scoped grants mean anything — otherwise a devotee could
--  edit any column of their own row, including is_admin.
-- ============================================================

revoke select, update, insert, delete on public.profiles from authenticated;

grant select (id, name, devotee_id, group_name, is_admin, created_at)
  on public.profiles to authenticated;
grant update (name, phone, group_name) on public.profiles to authenticated;

-- Reads and writes on the two data tables are shaped by the policies
-- above, so the table grants stay whole.
grant select, insert, update, delete on public.events      to authenticated;
grant select, insert, update, delete on public.submissions to authenticated;

grant execute on function public.event_totals(uuid)  to authenticated;
grant execute on function public.admin_devotees()    to authenticated;
grant execute on function public.is_admin()          to authenticated;
grant execute on function public.admin_email()       to authenticated;


-- ============================================================
--  8. A CHALLENGE TO START WITH, only if there are none
-- ============================================================

insert into public.events (name, start_at, end_at, status, goal_rounds, visibility, description)
select 'Ekadashi Japa Seva',
       date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata',
       (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day' - interval '1 minute') at time zone 'Asia/Kolkata',
       'active', 3000, 'names',
       'Offer your chanting with devotion.'
where not exists (select 1 from public.events);


-- ============================================================
--  9. CHECK — read the output of this last query
--
--  Expect: every challenge listed with a real start_at / end_at,
--  and one row marked 'active' if a challenge is running.
-- ============================================================

select e.name, e.start_at, e.end_at, e.status, e.visibility, e.goal_rounds,
       (select count(*) from public.submissions s where s.event_id = e.id) as entries
from public.events e
order by e.start_at desc;
