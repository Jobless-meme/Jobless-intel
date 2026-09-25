import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. This key bypasses RLS entirely — it must only ever
 * run in server code (API routes / route handlers), never shipped to the
 * browser. The `server-only` import above makes Next.js throw a build
 * error if anything client-side accidentally imports this file.
 *
 * Used for exactly two things in this app:
 *   1. reading/writing the auth_nonces table during Sign-In-With-Solana
 *      (see app/api/auth/nonce and app/api/auth/link-wallet);
 *   2. writing user_trade_stats from app/api/v1/leaderboard/sync, after
 *      re-deriving the numbers from the caller's SIWS-verified wallet's
 *      on-chain history (the browser has no write access to that table).
 * Every other table is written through the user's own authenticated
 * session + RLS, not through this client.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function getSupabaseAdminClient() {
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
