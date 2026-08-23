-- ============================================================
--  FIX 002 — challenges, leaderboard control, admin roles
--  Run this once in the Supabase SQL Editor. Safe to re-run.
--
--  A challenge is ONE CONTINUOUS WINDOW: it starts at a given date
--  and time and ends at a given date and time. It does not repeat
--  daily. Each devotee keeps a single running total for the whole
--  challenge, editable while the window is open.
--
--  Adds:
--   1. start_at / end_at timestamps on challenges.
--   2. Rounds only accepted while the window is genuinely open —
--      enforced in the database, not just the interface.
--   3. Leaderboard controls: visibility including a full "off".
--   4. Admin role management, with at least one admin always kept.
-- ============================================================

-- ---------- 1. Challenges get a real start/end timestamp ----------
alter table public.events add column if not exists end_date date;
update public.events set end_date = event_date where end_date is null;

alter table public.events add column if not exists start_at timestamptz;
alter table public.events add column if not exists end_at   timestamptz;

-- Backfill from the older date + clock-time columns (times were IST).
update public.events
set start_at = ((event_date::text || ' ' || coalesce(nullif(starts_at, ''), '00:00'))::timestamp
                at time zone 'Asia/Kolkata')
where start_at is null;

update public.events
set end_at = ((coalesce(end_date, event_date)::text || ' ' || coalesce(nullif(ends_at, ''), '23:59'))::timestamp
              at time zone 'Asia/Kolkata')
where end_at is null;

-- A window must not end before it begins.
update public.events set end_at = start_at where end_at < start_at;

alter table public.events alter column start_at set not null;
alter table public.events alter column end_at   set not null;

alter table public.events drop constraint if exists events_window_check;
alter table public.events add constraint events_window_check check (end_at >= start_at);

-- Visibility gains 'off' — the leaderboard fully disabled.
alter table public.events drop constraint if exists events_visibility_check;
alter table public.events add constraint events_visibility_check
  check (visibility in ('names', 'ids', 'admin', 'off'));

-- ---------- 2. One running total per devotee per challenge ----------
-- If an earlier per-day model was ever applied, collapse it by summing.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'entry_date'
  ) then
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

alter table public.submissions drop constraint if exists submissions_event_id_user_id_key;
alter table public.submissions add constraint submissions_event_id_user_id_key
  unique (event_id, user_id);

-- ---------- 3. Totals ----------
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
grant execute on function public.event_totals(uuid) to authenticated;

-- ---------- 4. Rounds only while the window is open ----------
drop policy if exists submissions_insert_own on public.submissions;
drop policy if exists submissions_update_own on public.submissions;

create policy submissions_insert_own on public.submissions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_id
        and e.status = 'active'
        and now() >= e.start_at
        and now() <= e.end_at
    )
  );

create policy submissions_update_own on public.submissions
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.events e
      where e.id = event_id
        and e.status = 'active'
        and now() >= e.start_at
        and now() <= e.end_at
    )
  );

-- Leaderboard privacy: 'admin' and 'off' hide other devotees' rows
-- at the database level, not merely in the interface.
drop policy if exists submissions_read on public.submissions;
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

-- ---------- 5. Admin role management ----------
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
grant execute on function public.set_admin(uuid, boolean) to authenticated;
