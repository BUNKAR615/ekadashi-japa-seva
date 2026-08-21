-- ============================================================
--  FIX 001 — stop devotees granting themselves admin rights
--  Run this in the Supabase SQL Editor. Safe to re-run.
--
--  Why this was needed
--  -------------------
--  Supabase grants blanket UPDATE on public tables to the
--  `authenticated` role. The column grant in schema.sql ADDED to that
--  grant rather than replacing it, so the RLS policy that lets a
--  devotee edit their own profile row also let them set is_admin = true
--  on themselves — and with it, read the phone directory and manage
--  events. Revoking the blanket grant first closes it, and a trigger
--  is added as a second line of defence.
-- ============================================================

-- 1. Replace the blanket UPDATE grant with a column-scoped one.
revoke update, insert, delete on public.profiles from authenticated;
grant  update (name, phone, group_name) on public.profiles to authenticated;

-- 2. Defence in depth: refuse any change to is_admin unless the caller
--    is already an admin. This holds even if a grant is loosened later.
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

-- 3. Reset anyone who escalated themselves during testing.
--    Re-grant admin deliberately afterwards (see the bottom of schema.sql).
update public.profiles set is_admin = false
where is_admin = true;

-- ============================================================
--  After running: make yourself an admin with your real email.
--
--    update public.profiles set is_admin = true
--    where id = (select id from auth.users where email = 'you@example.com');
--
--  That statement is run by you in the SQL Editor, which bypasses RLS,
--  so the new trigger does not block it.
-- ============================================================
