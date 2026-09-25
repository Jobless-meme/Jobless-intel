import { NextRequest, NextResponse } from "next/server";
import { Connection, clusterApiUrl, PublicKey } from "@solana/web3.js";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { auditCreator, type CreatorAudit } from "@/lib/creator-audit";

/**
 * GET /api/v1/creator-audit?creator=<deployer wallet>
 *
 * Same shape as app/api/v1/holders/route.ts: the scan is O(hundreds of
 * RPC calls) worst case, so it runs server-side once and gets cached in
 * Supabase — repeat lookups of a creator who's already been through the
 * SnipeX feed today are instant.
 */

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — a deployer's launch history doesn't need to be fresher than this for a feed badge

function getConnection() {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");
  return new Connection(endpoint, "confirmed");
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const creator = req.nextUrl.searchParams.get("creator");
  if (!creator) return bad("Missing `creator` query param");
  try {
    new PublicKey(creator);
  } catch {
    return bad("`creator` is not a valid Solana address");
  }

  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";

  let supabase;
  try {
    supabase = getSupabaseBrowserClient();
  } catch {
    supabase = null; // Supabase not configured — fall through to uncached, RPC-only mode
  }

  if (supabase && !forceRefresh) {
    const { data, error } = await supabase
      .from("creator_audits")
      .select("audit, fetched_at")
      .eq("creator_address", creator)
      .maybeSingle();

    if (!error && data) {
      const age = Date.now() - new Date(data.fetched_at).getTime();
      if (age < CACHE_TTL_MS) {
        return NextResponse.json({ ok: true, cached: true, ageMs: age, audit: data.audit as CreatorAudit });
      }
    }
  }

  try {
    const connection = getConnection();
    const audit = await auditCreator(connection, creator);

    if (supabase) {
      const { error: upsertError } = await supabase
        .from("creator_audits")
        .upsert({ creator_address: creator, audit, fetched_at: new Date().toISOString() });
      if (upsertError) console.error("creator audit cache write failed:", upsertError.message);
    }

    return NextResponse.json({ ok: true, cached: false, audit });
  } catch (err: any) {
    return bad(`Creator audit failed: ${err.message ?? "unknown error"}`, 502);
  }
}
