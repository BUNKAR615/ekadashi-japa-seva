-- ============================================================
--  CLEAN UP TEST DATA
--  Run in the Supabase SQL Editor. Read STEP 1 before running
--  STEP 2 — the deletions cannot be undone.
--
--  Keeps: the challenge named below, and the admin account.
--  Removes: every other challenge, and (optionally) every other
--           account along with the rounds they submitted.
-- ============================================================


-- ============================================================
--  STEP 1 — LOOK FIRST. Run this on its own and read the output.
-- ============================================================

-- Every challenge currently in the database
select e.name,
       e.start_at,
       e.end_at,
       e.status,
       (select count(*) from public.submissions s where s.event_id = e.id) as entries,
       e.id
from public.events e
order by e.created_at desc;

-- Every account currently in the database
select p.devotee_id,
       p.name,
       u.email,
       p.is_admin,
       (select count(*) from public.submissions s where s.user_id = p.id) as entries
from public.profiles p
join auth.users u on u.id = p.id
order by p.devotee_id;


-- ============================================================
--  STEP 2a — keep only the current challenge
--
--  Change the name below if yours is spelled differently. Copy it
--  exactly from the STEP 1 output. Deleting a challenge also
--  deletes the rounds submitted to it.
-- ============================================================

delete from public.events
where lower(trim(name)) <> lower(trim('Ekadashi Japa Yagna'));

-- Confirm one challenge remains
select name, start_at, end_at, status from public.events;


-- ============================================================
--  STEP 2b — remove test participants
--
--  WARNING: this deletes EVERY account except the admin, together
--  with their profiles and any rounds they offered. Run it only if
--  the STEP 1 account list contains nothing but test accounts. If
--  a real devotee has already registered, delete accounts one at a
--  time with the single-account statement further down instead.
-- ============================================================

delete from auth.users
where lower(email) <> lower(public.admin_email());

-- Devotee IDs start again from HKMM001 for the next real signup.
-- (The admin keeps whatever ID they already have.)
alter sequence public.devotee_seq restart with 1;


-- ============================================================
--  Removing ONE account instead (safer alternative to STEP 2b)
-- ============================================================
-- delete from auth.users where lower(email) = lower('someone@example.com');


-- ============================================================
--  STEP 3 — check the result
-- ============================================================

select 'challenges' as kind, count(*) from public.events
union all
select 'accounts',    count(*) from public.profiles
union all
select 'submissions', count(*) from public.submissions;
