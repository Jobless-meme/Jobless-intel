import { NextRequest, NextResponse } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { fetchRealizedPnl } from "@/lib/wallet-pnl";

/**
 * GET /api/v1/smart-money/winrate?wallet=<address>
 *
 * Wraps lib/wallet-pnl.ts's FIFO realized-PnL scan — the same real
 * calculation the Portfolio tab uses for the user's own wallet — and
 * caches it per wallet in Supabase. Win rate/realized PnL move slower
 * than holder sets do, so this gets a longer TTL than the holder
 * snapshot cache; it also only scans the most recent 100 signatures
 * rather than Portfolio's full history, since a Smart Money badge needs
 * a directional "this wallet wins often" read, not an audit-grade total.
 */

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getConnection() {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
  return new Connection(endpoint, "confirmed");
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) return bad("Missing `wallet` query param");

  let supabase;
  try {
    supabase = getSupabaseBrowserClient();
  } catch {
    supabase = null;
  }

  if (supabase) {
    const { data, error } = await supabase
      .from("wallet_win_rate_snapshots")
      .select("win_rate_pct, total_realized_sol, trades_scanned, fetched_at")
      .eq("wallet_address", wallet)
      .maybeSingle();

    if (!error && data) {
      const age = Date.now() - new Date(data.fetched_at).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({
          ok: true,
          cached: true,
          stat: {
            winRatePct: Number(data.win_rate_pct),
            totalRealizedSol: Number(data.total_realized_sol),
            tradesScanned: data.trades_scanned,
            fetchedAt: new Date(data.fetched_at).getTime(),
          },
        });
      }
    }
  }

  try {
    const connection = getConnection();
    const summary = await fetchRealizedPnl(connection, wallet, 100);
    const stat = {
      winRatePct: Math.round(summary.winRatePct * 10) / 10,
      totalRealizedSol: Math.round(summary.totalRealizedSol * 1000) / 1000,
      tradesScanned: summary.scannedSignatures,
      fetchedAt: Date.now(),
    };

    if (supabase) {
      const { error: upsertError } = await supabase.from("wallet_win_rate_snapshots").upsert({
        wallet_address: wallet,
        win_rate_pct: stat.winRatePct,
        total_realized_sol: stat.totalRealizedSol,
        trades_scanned: stat.tradesScanned,
        fetched_at: new Date().toISOString(),
      });
      if (upsertError) console.error("win-rate snapshot cache write failed:", upsertError.message);
    }

    return NextResponse.json({ ok: true, cached: false, stat });
  } catch (err: any) {
    return bad(`Win-rate lookup failed: ${err.message ?? "unknown error"}`, 502);
  }
}
