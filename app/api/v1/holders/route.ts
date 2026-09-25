import { NextRequest, NextResponse } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { fetchHolderAnalysis, type HolderAnalysis } from "@/lib/holder-analysis";

/**
 * GET /api/v1/holders?mint=<mint>&dev=<optional creator wallet>&createdAt=<optional ms epoch>
 *
 * Runs the holder/cluster trace server-side (it needs ~15+ sequential RPC
 * calls per uncached token — not something to run from every client) and
 * caches the result in Supabase so repeat views of the same token within
 * CACHE_TTL_MS are instant and don't re-hit RPC at all.
 *
 * `dev`/`createdAt` are optional context the caller may already have
 * (e.g. from PumpPortal's feed for a pump.fun mint) that sharpens the
 * dev/insider/sniper tagging — see lib/holder-analysis.ts. Without them
 * the panel still renders the supply-breakdown numbers, just with a
 * shallower insider trace.
 */

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — holder sets don't move fast enough to need fresher than this for a UI panel

function getConnection() {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
  return new Connection(endpoint, "confirmed");
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const mint = req.nextUrl.searchParams.get("mint");
  if (!mint) return bad("Missing `mint` query param");

  const devWallet = req.nextUrl.searchParams.get("dev") || undefined;
  const createdAtParam = req.nextUrl.searchParams.get("createdAt");
  const tokenCreatedAtMs = createdAtParam ? Number(createdAtParam) : undefined;
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  let supabase;
  try {
    supabase = getSupabaseBrowserClient();
  } catch {
    supabase = null; // Supabase not configured — fall through to uncached, RPC-only mode
  }

  if (supabase && !forceRefresh) {
    const { data, error } = await supabase
      .from("token_holder_snapshots")
      .select("analysis, fetched_at")
      .eq("token_mint", mint)
      .maybeSingle();

    if (!error && data) {
      const age = Date.now() - new Date(data.fetched_at).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({ ok: true, cached: true, ageMs: age, analysis: data.analysis as HolderAnalysis });
      }
    }
  }

  try {
    const connection = getConnection();
    const analysis = await fetchHolderAnalysis(connection, mint, {
      devWallet,
      tokenCreatedAtMs,
      skipClusterTrace: req.nextUrl.searchParams.get("fast") === "1",
    });

    if (supabase) {
      // Fire-and-forget-ish, but await it so a write failure doesn't
      // silently orphan the cache — still return the fresh analysis
      // either way, a caching failure shouldn't fail the request.
      const { error: upsertError } = await supabase
        .from("token_holder_snapshots")
        .upsert({ token_mint: mint, analysis, fetched_at: new Date().toISOString() });
      if (upsertError) console.error("holder snapshot cache write failed:", upsertError.message);
    }

    return NextResponse.json({ ok: true, cached: false, analysis });
  } catch (err: any) {
    return bad(`Holder analysis failed: ${err.message ?? "unknown error"}`, 502);
  }
}
