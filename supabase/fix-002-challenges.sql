-- ============================================================
--  FIX 002 — challenge & leaderboard management
--  Run this once in the Supabase SQL Editor. Safe to re-run.
--
--  Adds:
--   1. Challenges with a start AND end date (multi-day support),
--      with rounds recorded per day.
--   2. Admin choice of ranking parameter: total rounds or daily
--      progress.
--   3. Leaderboard controls: per-challenge visibility including a
--      full "off" switch, and an admin-chosen featured challenge
--      whose leaderboard devotees see.
--   4. Admin role management: admins can promote or demote other
--      devotees, with a guard so at least one admin always remains.
-- ============================================================

-- ---------- 1. Events become challenges ----------
alter table public.events add column if not exists end_date date;
update public.events set end_date = event_date where end_date is null;

alter table public.events add column if not exists rank_by text not null default 'total';
alter table public.events drop constraint if exists events_rank_by_check;
alter table public.events add constraint events_rank_by_check
  check (rank_by in ('total', 'daily'));

-- Visibility gains 'off' — the leaderboard fully disabled.
alter table public.events drop constraint if exists events_visibility_check;
alter table public.events add constraint events_visibility_check
  check (visibility in ('names', 'ids', 'admin', 'off'));

-- The challenge whose leaderboard devotees see. At most one; when none
-- is set the app falls back to the live challenge.
alter table public.events add column if not exists featured boolean not null default false;
drop index if exists public.events_single_featured_idx;
create unique index events_single_featured_idx on public.events ((featured)) where featured;

-- ---------- 2. Rounds are recorded per day ----------
alter table public.submissions add column if not exists entry_date date;
update public.submissions
  set entry_date = (updated_at at time zone 'Asia/Kolkata')::date
  where entry_date is null;
alter table public.submissions
  alter column entry_date set default (now() at time zone 'Asia/Kolkata')::date;
alter table public.submissions alter column entry_date set not null;

alter table public.submissions drop constraint if exists submissions_event_id_user_id_key;
alter table public.submissions drop constraint if exists submissions_event_user_day_key;
alter table public.submissions add constraint submissions_event_user_day_key
  unique (event_id, user_id, entry_date);

-- ---------- 3. Totals now aggregate per devotee across days ----------
drop function if exists public.event_totals(uuid);
create function public.event_totals(p_event uuid)
returns table (total bigint, participants bigint, average numeric, highest bigint)
language sql
security definer
stable
set search_path = public
as $$
  with per_user as (
    select user_id, sum(rounds) as r
    from public.submissions
    where event_id = p_event and rounds > 0
    group by user_id
  )
  select
    coalesce(sum(r), 0)::bigint,
    count(*)::bigint,
    coalesce(round(avg(r), 1), 0),
    coalesce(max(r), 0)::bigint
  from per_user;
$$;
grant execute on function public.event_totals(uuid) to authenticated;

-- ---------- 4. Admin role management ----------
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

-- ---------- Featured-challenge setter ----------
-- Exclusive by design: clears the old flag before setting the new one.
-- Passing null returns to "automatic" (the live challenge).
create or replace function public.set_featured_event(p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only temple admins can choose the displayed leaderboard';
  end if;
  update public.events set featured = false where featured;
  if p_event is not null then
    update public.events set featured = true where id = p_event;
  end if;
end;
$$;
grant execute on function public.set_featured_event(uuid) to authenticated;
