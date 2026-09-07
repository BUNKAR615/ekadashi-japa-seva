-- ============================================================
--  VERIFY — is the account system sound?
--
--  Paste into the Supabase SQL Editor and run. It READS ONLY:
--  no row is created, changed or deleted, so it is safe to run
--  on the live temple database at any time.
--
--  Every row should say PASS. Anything else names its own cure.
--
--  One thing this cannot see: the Redirect URLs list under
--  Authentication > URL Configuration. That lives in the auth
--  service, not the database, and a missing entry fails silently
--  — the reset link simply lands on the Site URL instead of the
--  app. Check it by eye, or by using Forgot password once.
-- ============================================================

with
  ep as (select to_regprocedure('public.ensure_profile(text)') as oid),
  ad as (select to_regprocedure('public.admin_devotees()')     as oid),
  counts as (
    select
      (select count(*) from auth.users)                              as accounts,
      (select count(*) from public.profiles)                         as profiles,
      (select count(*) from auth.users u
         left join public.profiles p on p.id = u.id
        where p.id is null)                                          as orphans,
      (select count(*) from (
         select lower(email) from auth.users
          where email is not null and email <> ''
          group by lower(email) having count(*) > 1) d)              as dupe_addresses,
      (select count(*) from public.profiles where devotee_id is null) as no_devotee_id,
      (select count(*) from public.profiles where is_admin)           as admins,
      (select count(*) from public.submissions)                       as submissions,
      (select coalesce(sum(rounds), 0) from public.submissions)       as rounds_recorded,
      (select count(*) from (
         select name from public.profiles group by name having count(*) > 1) s) as shared_names
  ),
  seq as (
    select
      coalesce((select last_value from public.devotee_seq), 0) as counter,
      coalesce((select max((regexp_replace(devotee_id, '\D', '', 'g'))::bigint)
                  from public.profiles where devotee_id ~ '^HKMM[0-9]+$'), 0) as highest
  ),
  checks as (
    select 1 as n, 'fix-004 applied' as item,
      case when (select oid from ep) is not null then 'PASS' else 'FAIL' end as status,
      case when (select oid from ep) is not null
           then 'ensure_profile() is present'
           else 'Run supabase/fix-004-accounts.sql in this editor' end as detail

    union all select 2, 'Admin directory shows addresses',
      case when (select oid from ad) is not null
            and pg_get_function_result((select oid from ad)) like '%email%'
           then 'PASS' else 'FAIL' end,
      case when (select oid from ad) is null then 'admin_devotees() is missing entirely'
           when pg_get_function_result((select oid from ad)) like '%email%'
           then 'Two devotees of the same name can be told apart'
           else 'Old version without email — run fix-004-accounts.sql' end

    union all select 3, 'Every account has a profile',
      case when (select orphans from counts) = 0 then 'PASS' else 'FAIL' end,
      case when (select orphans from counts) = 0
           then (select accounts || ' account(s), ' || profiles || ' profile(s)' from counts)
           else (select orphans || ' account(s) cannot sign in — run fix-004-accounts.sql' from counts) end

    union all select 4, 'One account per email address',
      case when (select dupe_addresses from counts) = 0 then 'PASS' else 'FAIL' end,
      case when (select dupe_addresses from counts) = 0
           then 'No address is registered twice'
           else (select dupe_addresses || ' address(es) appear on more than one account' from counts) end

    union all select 5, 'Every devotee has an ID',
      case when (select no_devotee_id from counts) = 0 then 'PASS' else 'FAIL' end,
      case when (select no_devotee_id from counts) = 0
           then 'All profiles carry an HKMM number'
           else (select no_devotee_id || ' profile(s) have none — run fix-004-accounts.sql' from counts) end

    union all select 6, 'Exactly one admin',
      (select case when admins = 1 then 'PASS'
                   when admins > 1 then 'FAIL'
                   when accounts = 0 then 'INFO'
                   else 'WARN' end from counts),
      (select case when admins = 1 then 'The admin is ' || public.admin_email()
                   when admins > 1 then admins || ' admin accounts — only one address may be admin'
                   when accounts = 0 then 'No accounts yet; ' || public.admin_email() || ' becomes admin on signup'
                   else public.admin_email() || ' has not created an account yet'
              end from counts)

    union all select 7, 'Devotee ID counter is ahead',
      case when (select counter from seq) >= (select highest from seq) then 'PASS' else 'FAIL' end,
      (select 'counter at ' || counter || ', highest issued ' || highest from seq)

    union all select 8, 'Devotees sharing a name stay separate',
      'INFO',
      (select case when shared_names = 0
                   then 'No two devotees share a name yet'
                   else shared_names || ' name(s) used by more than one account — each keeps its own rounds'
              end from counts)

    union all select 9, 'Rounds on record',
      'INFO',
      (select submissions || ' entr(ies), ' || rounds_recorded || ' rounds in total' from counts)
  )
select status, item, detail from checks order by n;
