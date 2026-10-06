-- ============================================================
--  DIAGNOSE — why can the admin not sign in?
--
--  Paste into the Supabase SQL Editor and run. It READS ONLY:
--  nothing is created, changed or deleted.
--
--  Run it BEFORE fix-006, so it shows the account as it was when
--  sign-in was failing. fix-006 repairs the things this reports.
--
--  No password or token is shown — only whether one is set.
-- ============================================================

with
  admin as (
    select to_jsonb(u) as j, u.id
    from auth.users u
    where lower(u.email) = lower(public.admin_email())
  ),
  prof as (
    select p.* from public.profiles p where p.id = (select id from admin)
  ),
  subs as (
    select count(*) as n, coalesce(sum(rounds), 0) as rounds
    from public.submissions where user_id = (select id from admin)
  ),
  ep as (select to_regprocedure('public.ensure_profile(text)') as oid),
  ca as (select to_regprocedure('public.claim_account(text,text,text)') as oid),
  checks as (
    select 1 as n, 'Admin address' as item,
      'INFO' as status, public.admin_email() as detail

    union all select 2, 'Account exists for that address',
      case when exists (select 1 from admin) then 'PASS' else 'FAIL' end,
      coalesce((select 'created ' || (j ->> 'created_at') from admin),
               'No auth account uses this address — it must sign up (Create Account) first')

    union all select 3, 'Address confirmed',
      case when (select j ->> 'email_confirmed_at' from admin) is not null then 'PASS' else 'FAIL' end,
      coalesce((select j ->> 'email_confirmed_at' from admin), 'Unconfirmed — sign-in answers "Email not confirmed"')

    union all select 4, 'Not banned or deleted',
      case when (select coalesce(j ->> 'banned_until', '') = '' and coalesce(j ->> 'deleted_at', '') = '' from admin)
           then 'PASS' else 'FAIL' end,
      coalesce((select 'banned_until=' || coalesce(j ->> 'banned_until', '-') || ', deleted_at=' || coalesce(j ->> 'deleted_at', '-') from admin), '-')

    union all select 5, 'Password is set',
      case when (select coalesce(j ->> 'encrypted_password', '') <> '' from admin) then 'PASS' else 'FAIL' end,
      'Hash present: ' || coalesce((select (coalesce(j ->> 'encrypted_password', '') <> '')::text from admin), '-')

    union all select 6, 'Email identity row',
      case when (select count(*) from auth.identities i where i.user_id = (select id from admin)) > 0 then 'PASS' else 'FAIL' end,
      (select count(*) || ' identit(ies)' from auth.identities i where i.user_id = (select id from admin))

    union all select 7, 'Profile row exists',
      case when exists (select 1 from prof) then 'PASS' else 'FAIL' end,
      case when exists (select 1 from prof)
           then (select name || ' · ' || coalesce(devotee_id, 'no ID') from prof)
           else 'MISSING — the app stops at "Your devotee profile is still being set up"' end

    union all select 8, 'Profile carries the admin flag',
      case when (select is_admin from prof) then 'PASS' else 'FAIL' end,
      coalesce((select 'is_admin=' || is_admin::text from prof), 'no profile')

    union all select 9, 'ensure_profile() installed (fix-004)',
      case when (select oid from ep) is not null then 'PASS' else 'FAIL' end,
      case when (select oid from ep) is not null then 'present'
           else 'MISSING — an account without a profile cannot be repaired at sign-in' end

    union all select 10, 'claim_account() installed (fix-005)',
      'INFO',
      case when (select oid from ca) is null then 'not installed'
           else 'installed — Create Account with an address replaces its password and signs it out everywhere' end

    union all select 11, 'Last sign-in',
      'INFO',
      coalesce((select j ->> 'last_sign_in_at' from admin), 'never')

    union all select 12, 'Account record last changed',
      'INFO',
      coalesce((select (j ->> 'updated_at') ||
        case when (j ->> 'updated_at')::timestamptz > coalesce((j ->> 'last_sign_in_at')::timestamptz, 'epoch'::timestamptz) + interval '1 minute'
             then '  (AFTER the last sign-in — the password may have been replaced since)'
             else '' end from admin), '-')

    union all select 13, 'Live sessions',
      'INFO',
      (select count(*) || ' session(s)' from auth.sessions s where s.user_id = (select id from admin))

    union all select 14, 'Rounds on record',
      'INFO',
      (select n || ' challenge entr(ies), ' || rounds || ' rounds' from subs)

    union all select 15, 'Recent auth activity',
      'INFO',
      coalesce((
        select string_agg((a.payload ->> 'action') || ' @ ' || to_char(a.created_at, 'YYYY-MM-DD HH24:MI'), ' | ' order by a.created_at desc)
        from (select * from auth.audit_log_entries
              where payload ->> 'actor_id' = (select id::text from admin)
              order by created_at desc limit 8) a
      ), 'none recorded')

    union all select 16, 'Accounts overall',
      'INFO',
      (select count(*) from auth.users) || ' account(s), ' ||
      (select count(*) from public.profiles) || ' profile(s), ' ||
      (select count(*) from auth.users u left join public.profiles p on p.id = u.id where p.id is null) || ' without a profile'
  )
select status, item, detail from checks order by n;
