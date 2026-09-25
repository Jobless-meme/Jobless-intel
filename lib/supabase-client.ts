import { createClient } from "@supabase/supabase-js";

/**
 * Anon-key client for browser use. This key is meant to be public — the
 * actual security boundary is the RLS policies in supabase/schema.sql,
 * not secrecy of this key. Never put the service-role key here.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function getSupabaseBrowserClient() {
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY not configured");
  }
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}
