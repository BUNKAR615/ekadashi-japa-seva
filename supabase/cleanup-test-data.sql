-- ============================================================
--  CLEAN UP TEST DATA
--  Run in the Supabase SQL Editor, AFTER fix-002-challenges.sql.
--
--  Read STEP 1 before deleting anything. Deletions cannot be undone,
--  and real devotees have already registered — do not remove an
--  account unless you recognise it as a test.
-- ============================================================


-- ============================================================
--  STEP 1 — LOOK FIRST. Run this alone and read the output.
-- ============================================================

-- Every challenge
select e.name, e.start_at, e.end_at, e.status,
       (select count(*) from public.submissions s where s.event_id = e.id) as entries,
       e.id
from public.events e
order by e.created_at desc;

-- Every account, with how many rounds it has offered
select p.devotee_id, p.name, u.email, p.is_admin,
       coalesce((select sum(s.rounds) from public.submissions s where s.user_id = p.id), 0) as rounds
from public.profiles p
join auth.users u on u.id = p.id
order by p.devotee_id;


-- ============================================================
--  STEP 2 — remove the verification account
--
--  Created while testing that new registrations work. Safe to delete.
-- ============================================================

delete from auth.users where lower(email) = lower('zz-verify-delete-me@example.com');


-- ============================================================
--  STEP 3 — remove a challenge you no longer want
--
--  Fill in the name exactly as STEP 1 printed it. Deleting a
--  challenge also deletes the rounds offered to it, so check the
--  "entries" column first.
-- ============================================================

-- delete from public.events where lower(trim(name)) = lower(trim('PUT THE NAME HERE'));


-- ============================================================
--  STEP 4 — remove one test account
--
--  One address at a time, on purpose. Do NOT bulk-delete: several
--  genuine devotees have already signed up.
-- ============================================================

-- delete from auth.users where lower(email) = lower('someone@example.com');


-- ============================================================
--  STEP 5 — check the result
-- ============================================================

select 'challenges' as kind, count(*) from public.events
union all
select 'accounts',    count(*) from public.profiles
union all
select 'submissions', count(*) from public.submissions;
