-- ============================================================
--  FIX 001 — run this once in the Supabase SQL Editor.
--  Safe to re-run.
--
--  1. Closes a privilege-escalation hole (devotees could make
--     themselves admins).
--  2. Removes the accounts created while testing.
--  3. Makes the FIRST devotee who signs up the temple admin,
--     so no follow-up query is needed.
-- ============================================================

-- ---------- 1. Close the escalation hole ----------
-- Supabase grants blanket privileges on public tables to `authenticated`.
-- The column grant in schema.sql ADDED to that rather than replacing it,
-- so the policy letting a devotee edit their own profile row also let
-- them set is_admin = true on themselves.
revoke update, insert, delete on public.profiles from authenticated;
grant  update (name, phone, group_name) on public.profiles to authenticated;

-- Defence in depth: refuse any change to is_admin from a non-admin,
-- even if the grants above are ever loosened.
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

-- ---------- 2. Clear out the test accounts ----------
-- Profiles and submissions are removed automatically (on delete cascade).
delete from auth.users
where email like '%japa.test%'
   or email like 'ui.test%'
   or email like 'test.devotee%';

-- Start devotee IDs again from HKMM001.
alter sequence public.devotee_seq restart with 1;

-- ---------- 3. Bootstrap the first devotee as admin ----------
-- The first person to register becomes the temple admin; everyone after
-- that is an ordinary devotee. Sign up in the app straight after running
-- this, so the first account is yours.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first boolean;
begin
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

-- ---------- Check ----------
select count(*) as remaining_devotees from public.profiles;
