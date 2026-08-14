import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client, authenticated with the secret key.
 *
 * Every table has RLS enabled with no policies, so this key is the only way in. The browser
 * never talks to Postgres directly — it goes through this app's route handlers. That keeps the
 * secret key server-side and means we never have to write a policy for a single-user app.
 */

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new Error(
      'SUPABASE_URL is not set. Add it to .env.local — find it under ' +
        'Supabase dashboard → Project Settings → Data API.',
    );
  }
  if (!key) {
    throw new Error('SUPABASE_SECRET_KEY is not set. Add it to .env.local.');
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
