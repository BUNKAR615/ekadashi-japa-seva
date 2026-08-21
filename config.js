/* ============================================================
   Supabase connection settings.

   These two values come from the Supabase dashboard:
     Project Settings > Data API  ->  Project URL
     Project Settings > API Keys  ->  anon / publishable key

   The publishable key is designed to be public — it is safe here and
   in the public repo. Every real permission is enforced by the row
   level security policies in supabase/schema.sql, not by this file.

   NEVER put the service_role / secret key here; it bypasses all security.

   Blank these out to fall back to demo mode (data saved per browser).
   ============================================================ */

window.JAPA_CONFIG = {
  supabaseUrl: 'https://qziixgpvdlefvssmpnok.supabase.co',
  supabaseAnonKey: 'sb_publishable_vha7NDSK5Z0u2bmG3pVGHA_FQ0HFLzD'
};
