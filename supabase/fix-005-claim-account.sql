-- ============================================================
--  FIX 005 — Create Account replaces an existing account
--
--  RUN THIS ONCE in the Supabase SQL Editor, after
--  fix-004-accounts.sql. Safe to re-run.
--
--  WHAT IT DOES
--  ------------
--  The email address is the account. When somebody uses Create
--  Account with an address that already has one, no second account
--  is made and the old password is not asked for. The account's
--  details are replaced with what was just typed — the new password
--  included — and it keeps its id, so every round, every challenge
--  and the devotee ID stay attached to it.
--
--  READ THIS BEFORE RUNNING IT
--  ---------------------------
--  This deliberately removes the check that the person typing an
--  address owns it. Anyone who knows a devotee's address can set a
--  new password on their account and sign in as them — their rounds,
--  their history, their name.
--
--  That includes the temple admin address in admin_email(), which is
--  published in this repository. Anyone who reads it can take the
--  Admin tab: the devotee directory with phone numbers, the CSV
--  export, and control of every challenge.
--
--  This was asked for knowingly, to spare devotees who have
--  forgotten their password the emailed reset link. The safe way to
--  do the same thing is still in place and still works — Forgot
--  password on the sign-in card. If you want that to be the only
--  way, drop this function:
--
--      drop function if exists public.claim_account(text, text, text);
--
--  and the app falls back to the emailed link on its own.
-- ============================================================


-- pgcrypto supplies crypt()/gen_salt(). Supabase keeps extensions in
-- their own schema; this is a no-op if it is already installed.
create extension if not exists pgcrypto with schema extensions;


-- ============================================================
--  claim_account(email, password, name)
--
--  Returns {"found": false} when nothing is registered under that
--  address — the app then creates a new account through Supabase Auth
--  in the ordinary way.
--
--  Returns {"found": true, "user_id": ...} when the address already
--  has an account, having replaced its password and name. The app
--  then signs in with the new password.
--
--  Only ever touches the one account matching the address: its
--  password, its confirmation stamp, its name. Rounds, submissions,
--  challenge history and the devotee ID are never written here.
-- ============================================================

create or replace function public.claim_account(
  p_email    text,
  p_password text,
  p_name     text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id    uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name  text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
begin
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Please enter a valid email address.' using errcode = '22023';
  end if;

  -- The same floor Supabase Auth applies to a password.
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Password must be at least 6 characters.' using errcode = '22023';
  end if;

  -- The address identifies the account. Never the name: several
  -- devotees may be called Dinesh, and they are separate people.
  select u.id into v_id
  from auth.users u
  where lower(u.email) = v_email
    and u.deleted_at is null
  order by u.created_at
  limit 1;

  if v_id is null then
    return json_build_object('found', false);
  end if;

  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf', 10)),
         -- An account that never confirmed its address would otherwise
         -- still be refused at sign-in.
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                              || case when v_name is null then '{}'::jsonb
                                      else jsonb_build_object('name', v_name) end,
         updated_at = now()
   where id = v_id;

  -- The password has changed, so anything signed in with the old one
  -- is no longer signed in. Wrapped because these tables belong to
  -- Supabase and their shape is not ours to depend on.
  begin
    if to_regclass('auth.refresh_tokens') is not null then
      delete from auth.refresh_tokens where user_id = v_id::text;
    end if;
    if to_regclass('auth.sessions') is not null then
      delete from auth.sessions where user_id = v_id;
    end if;
  exception when others then
    null;
  end;

  -- The profile keeps its primary key — which is the account id — so
  -- every submission already filed against it stays filed against it.
  -- Only the name is replaced.
  if exists (select 1 from public.profiles p where p.id = v_id) then
    update public.profiles p
       set name = coalesce(v_name, p.name)
     where p.id = v_id;
  else
    insert into public.profiles (id, name, devotee_id)
    select v_id,
           coalesce(v_name, nullif(split_part(v_email, '@', 1), ''), 'Devotee'),
           'HKMM' || lpad(nextval('public.devotee_seq')::text, 3, '0')
    where not exists (select 1 from public.profiles p2 where p2.id = v_id);
  end if;

  return json_build_object('found', true, 'user_id', v_id);
end;
$$;

-- Callable before sign-in, which is the whole point of it.
revoke all on function public.claim_account(text, text, text) from public;
grant execute on function public.claim_account(text, text, text) to anon, authenticated;


-- ============================================================
--  REPORT
-- ============================================================

do $$
begin
  raise notice 'claim_account() installed.';
  raise notice 'Create Account with a registered address now replaces that account''s password and name.';
  raise notice 'The address is no longer proof of ownership — including %.', public.admin_email();
end $$;
