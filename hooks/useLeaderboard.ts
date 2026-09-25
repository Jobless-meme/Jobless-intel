"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

export type LeaderboardSort = "pnl" | "roi" | "winrate" | "volume";

export interface LeaderboardRow {
  place: number;
  displayName: string;
  tradesClosed: number;
  winRatePct: number;
  totalVolumeSol: number;
  totalRealizedSol: number;
  bestRoiPct: number | null;
  syncedAt: string | null;
  isYou: boolean;
}

export interface MyTradeStats {
  tradesClosed: number;
  winRatePct: number;
  totalVolumeSol: number;
  totalRealizedSol: number;
  bestRoiPct: number | null;
  bestRoiSignature: string | null;
  signaturesScanned: number;
  leaderboardOptIn: boolean;
  syncedAt: string | null;
}

const num = (v: unknown) => (v == null ? 0 : Number(v));

function mapRow(r: any): LeaderboardRow {
  return {
    place: Number(r.place),
    displayName: String(r.display_name ?? ""),
    tradesClosed: num(r.trades_closed),
    winRatePct: num(r.win_rate_pct),
    totalVolumeSol: num(r.total_volume_sol),
    totalRealizedSol: num(r.total_realized_sol),
    bestRoiPct: r.best_roi_pct == null ? null : Number(r.best_roi_pct),
    syncedAt: r.synced_at ?? null,
    isYou: r.is_you === true,
  };
}

function mapMine(r: any): MyTradeStats {
  return {
    tradesClosed: num(r.trades_closed),
    winRatePct: num(r.win_rate_pct),
    totalVolumeSol: num(r.total_volume_sol),
    totalRealizedSol: num(r.total_realized_sol),
    bestRoiPct: r.best_roi_pct == null ? null : Number(r.best_roi_pct),
    bestRoiSignature: r.best_roi_signature ?? null,
    signaturesScanned: num(r.signatures_scanned),
    leaderboardOptIn: r.leaderboard_opt_in === true,
    syncedAt: r.synced_at ?? null,
  };
}

/**
 * Community leaderboard + the caller's own stats.
 *
 * Reads go through the get_leaderboard() RPC (public, opted-in rows only)
 * and a plain select on the caller's own user_trade_stats row (RLS). The
 * ONLY write paths are the server sync route (stats) and the
 * set_leaderboard_opt_in RPC (listing on/off) — see supabase/schema.sql §15
 * for why the browser can't write scores.
 */
export function useLeaderboard(initialSort: LeaderboardSort = "pnl") {
  const [sort, setSort] = useState<LeaderboardSort>(initialSort);
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [me, setMe] = useState<MyTradeStats | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const reqId = useRef(0);

  const supabase = useMemo(() => {
    try {
      return getSupabaseBrowserClient();
    } catch {
      return null;
    }
  }, []);

  const loadMine = useCallback(async () => {
    if (!supabase) return;
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id;
    setSignedIn(!!uid);
    if (!uid) {
      setMe(null);
      return;
    }
    const { data } = await supabase.from("user_trade_stats").select("*").eq("user_id", uid).maybeSingle();
    setMe(data ? mapMine(data) : null);
  }, [supabase]);

  const refresh = useCallback(async () => {
    if (!supabase) {
      setError("Supabase isn't configured");
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc("get_leaderboard", { p_sort: sort, p_limit: 50 });
      if (rpcErr) throw rpcErr;
      if (id !== reqId.current) return; // a newer sort/refresh superseded this one
      setRows(((data ?? []) as any[]).map(mapRow));
      await loadMine();
    } catch (err: any) {
      if (id === reqId.current) setError(err?.message ?? "Failed to load leaderboard");
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [supabase, sort, loadMine]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Server re-derives your stats from your verified wallet's on-chain history. */
  const syncMine = useCallback(async () => {
    if (!supabase) return;
    setSyncing(true);
    setError(null);
    setNote(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Sign in with your wallet first (Settings → Cloud Sync).");

      const res = await fetch("/api/v1/leaderboard/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Sync failed");
      if (body.cooledDown) setNote("Stats were synced moments ago — showing those.");
      else if (body.truncated) setNote("Only your most recent transactions were scanned.");
      await refresh();
    } catch (err: any) {
      setError(err?.message ?? "Sync failed");
    } finally {
      setSyncing(false);
    }
  }, [supabase, refresh]);

  const setOptIn = useCallback(
    async (optIn: boolean) => {
      if (!supabase) return;
      setError(null);
      const { error: rpcErr } = await supabase.rpc("set_leaderboard_opt_in", { p_opt_in: optIn });
      if (rpcErr) {
        setError(
          /foreign key|violates/i.test(rpcErr.message)
            ? "Link your wallet first (Settings → Cloud Sync) before joining the leaderboard."
            : rpcErr.message
        );
        return;
      }
      await refresh();
    },
    [supabase, refresh]
  );

  return { sort, setSort, rows, me, signedIn, loading, syncing, error, note, refresh, syncMine, setOptIn };
}
