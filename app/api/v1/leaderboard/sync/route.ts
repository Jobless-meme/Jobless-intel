import { NextRequest, NextResponse } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { fetchRealizedPnl } from "@/lib/wallet-pnl";
import { deriveClosedPositions } from "@/lib/closed-positions";
import { computeTradeStats } from "@/lib/trade-stats";

/**
 * Recomputes the caller's leaderboard stats from ON-CHAIN history and
 * writes them to user_trade_stats.
 *
 * Why this is a server route and not a client insert: a leaderboard row a
 * client can write is a leaderboard row a client can forge. So:
 *   1. The caller proves who they are with their Supabase session (the same
 *      SIWS-backed identity the rest of the app uses).
 *   2. The wallet comes from public.users.sol_wallet_address — the address
 *      that already passed nonce+signature verification in
 *      /api/auth/link-wallet — never from the request body.
 *   3. Every stat is derived here from that wallet's transactions; the
 *      request carries no numbers at all.
 *   4. Only then does the service-role client upsert. RLS forbids the
 *      browser from writing this table, so this is the single write path.
 *
 * Trades from burner/session wallets aren't counted: only the SIWS-proven
 * wallet's history can be tied to the account.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_SIGNATURES = 120; // getParsedTransaction is 1 RPC call per signature
const inflight = new Set<string>(); // per-instance double-click guard; the cooldown is the real limiter

function rpcConnection() {
  const url = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
  return new Connection(url, "confirmed");
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Missing session — sign in with your wallet first" }, { status: 401 });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });

  // Act as the caller so RLS decides what they can see of their own identity.
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return NextResponse.json({ error: "Invalid or expired session — sign in again" }, { status: 401 });
  }
  const userId = userData.user.id;

  const { data: profile } = await userClient.from("users").select("sol_wallet_address").eq("id", userId).maybeSingle();
  const wallet = profile?.sol_wallet_address as string | null | undefined;
  if (!wallet) {
    return NextResponse.json({ error: "No verified wallet on this account — run Sync Across Devices first" }, { status: 409 });
  }

  const admin = getSupabaseAdminClient();
  const { data: existing } = await admin.from("user_trade_stats").select("*").eq("user_id", userId).maybeSingle();
  if (existing?.synced_at && Date.now() - new Date(existing.synced_at).getTime() < SYNC_COOLDOWN_MS) {
    return NextResponse.json({ ok: true, cooledDown: true, stats: existing });
  }
  if (inflight.has(userId)) return NextResponse.json({ error: "A sync is already running" }, { status: 429 });

  inflight.add(userId);
  try {
    let summary;
    try {
      summary = await fetchRealizedPnl(rpcConnection(), wallet, MAX_SIGNATURES);
    } catch (err: any) {
      return NextResponse.json(
        { error: `RPC read failed (${err?.message ?? "unknown"}). Set SOLANA_RPC_URL to a real provider and retry.` },
        { status: 502 }
      );
    }

    const positions = deriveClosedPositions(summary.trades);
    const stats = computeTradeStats(summary.trades, positions);

    // upsert only names these columns, so leaderboard_opt_in is untouched.
    const { data: saved, error: saveErr } = await admin
      .from("user_trade_stats")
      .upsert(
        {
          user_id: userId,
          trades_closed: stats.tradesClosed,
          wins: stats.wins,
          win_rate_pct: stats.winRatePct,
          total_volume_sol: stats.totalVolumeSol,
          total_realized_sol: stats.totalRealizedSol,
          best_roi_pct: stats.bestRoiPct,
          best_roi_mint: stats.bestRoiMint,
          best_roi_signature: stats.bestRoiSignature,
          signatures_scanned: summary.scannedSignatures,
          synced_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      )
      .select("*")
      .single();
    if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, cooledDown: false, truncated: summary.truncated, stats: saved });
  } finally {
    inflight.delete(userId);
  }
}
