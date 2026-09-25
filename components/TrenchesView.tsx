"use client";

import { useEffect, useMemo, useState } from "react";
import { usePumpNewTokens, usePumpTokenTrades, type PumpNewToken } from "@/lib/pump-portal";
import { getSmartMoneyPrefs, saveSmartMoneyPrefs, type SmartMoneyPrefs } from "@/lib/smart-money";
import SmartMoneyFeedView from "@/components/SmartMoneyFeedView";

/* ------------------------------------------------------------------ */
/* MIGRATED column — polls GeckoTerminal's real new_pools endpoint,    */
/* filtered to Raydium, as the "completed bonding curve" signal.       */
/* ------------------------------------------------------------------ */
interface MigratedPool {
  poolAddress: string;
  name: string;
  tokenAddress: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  createdAt: string;
}

async function fetchMigratedPools(): Promise<MigratedPool[]> {
  const res = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GeckoTerminal new_pools failed: ${res.status}`);
  const data = await res.json();
  const pools = (data?.data as any[] | undefined) ?? [];

  return pools
    .filter((p) => String(p.relationships?.dex?.data?.id ?? "").includes("raydium"))
    .slice(0, 20)
    .map((p) => ({
      poolAddress: p.attributes.address,
      name: p.attributes.name ?? "Unknown",
      tokenAddress: p.relationships?.base_token?.data?.id?.split("_").slice(1).join("_") ?? "",
      priceUsd: Number(p.attributes.base_token_price_usd ?? 0),
      volume24hUsd: Number(p.attributes.volume_usd?.h24 ?? 0),
      liquidityUsd: Number(p.attributes.reserve_in_usd ?? 0),
      createdAt: p.attributes.pool_created_at,
    }))
    .filter((p) => p.tokenAddress);
}

function useMigratedFeed() {
  const [pools, setPools] = useState<MigratedPool[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchMigratedPools();
        if (!cancelled) setPools(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      }
    }
    load();
    const t = setInterval(load, 45_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return { pools, error };
}

/* ------------------------------------------------------------------ */
/* Shared card                                                         */
/* ------------------------------------------------------------------ */
function ageLabel(fromMs: number) {
  const s = Math.floor((Date.now() - fromMs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function TokenCard({
  symbol,
  name,
  mint,
  subtitle,
  progressPct,
  onBuy,
}: {
  symbol: string;
  name: string;
  mint: string;
  subtitle: string;
  progressPct?: number;
  onBuy: () => void;
}) {
  return (
    <div className="glass-panel flex items-center justify-between gap-2 rounded-xl px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-elevated-strong)] font-mono text-[10px]">
          {symbol.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate font-mono text-[10px] text-[var(--text-dim)]">{subtitle}</div>
          {progressPct != null && (
            <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-[var(--bg-elevated-strong)]">
              <div
                className="h-full rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.min(100, progressPct)}%` }}
              />
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onBuy}
        className="shrink-0 rounded-full bg-[var(--success)] px-3 py-1.5 font-mono text-[11px] font-semibold text-black"
      >
        Buy
      </button>
    </div>
  );
}

export default function TrenchesView({ onBuyToken }: { onBuyToken: (mint: string) => void }) {
  const [prefs, setPrefs] = useState<SmartMoneyPrefs>({ mode: "all", tiers: ["kol", "smart_money", "whale"] });
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    setPrefs(getSmartMoneyPrefs());
    let cancelled = false;
    import("@/lib/supabase-client").then(({ getSupabaseBrowserClient }) => {
      try {
        getSupabaseBrowserClient()
          .auth.getSession()
          .then(({ data }) => !cancelled && setUserId(data.session?.user?.id ?? null));
      } catch {
        /* Supabase not configured this deploy — mode toggle stays local-only, which is fine */
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function setMode(mode: SmartMoneyPrefs["mode"]) {
    const next = { ...prefs, mode };
    setPrefs(next);
    saveSmartMoneyPrefs(userId, next);
  }

  const newTokens = usePumpNewTokens(30);
  const almostBondedCandidateMints = useMemo(
    () => newTokens.filter((t) => t.bondingProgressPct >= 40).map((t) => t.mint),
    [newTokens]
  );
  const liveTrades = usePumpTokenTrades(almostBondedCandidateMints);
  const { pools: migrated, error: migratedError } = useMigratedFeed();

  const withLiveProgress: PumpNewToken[] = newTokens.map((t) => {
    const trade = liveTrades[t.mint];
    return trade ? { ...t, bondingProgressPct: trade.bondingProgressPct, vSolInBondingCurve: trade.vSolInBondingCurve } : t;
  });

  const newList = withLiveProgress.filter((t) => t.bondingProgressPct < 85);
  const almostBonded = withLiveProgress.filter((t) => t.bondingProgressPct >= 85);

  return (
    <div className="flex flex-col gap-4 px-4 pb-32 pt-2">
      <div className="flex items-center justify-between">
        <span className="font-display text-sm font-semibold">Trenches</span>
        <span className="font-mono text-[10px] text-[var(--text-dim)]">LIVE · PumpPortal</span>
      </div>

      <div className="flex gap-1.5 rounded-full bg-[var(--bg-elevated-strong)] p-1">
        <button
          type="button"
          onClick={() => setMode("all")}
          className="flex-1 rounded-full py-1.5 font-mono text-[11px] font-semibold transition-colors"
          style={{
            background: prefs.mode === "all" ? "var(--accent)" : "transparent",
            color: prefs.mode === "all" ? "black" : "var(--text-dim)",
          }}
        >
          All Trenches
        </button>
        <button
          type="button"
          onClick={() => setMode("smart_only")}
          className="flex-1 rounded-full py-1.5 font-mono text-[11px] font-semibold transition-colors"
          style={{
            background: prefs.mode === "smart_only" ? "var(--accent)" : "transparent",
            color: prefs.mode === "smart_only" ? "black" : "var(--text-dim)",
          }}
        >
          Smart Money Only
        </button>
      </div>

      {prefs.mode === "smart_only" ? (
        <SmartMoneyFeedView onBuyToken={onBuyToken} />
      ) : (
        <>
          <Column title="New" count={newList.length}>
            {newList.length === 0 && <EmptyRow text="Waiting for new mints…" />}
            {newList.map((t) => (
              <TokenCard
                key={t.mint}
                symbol={t.symbol}
                name={t.name}
                mint={t.mint}
                subtitle={`${ageLabel(t.createdAt)} ago · MC ${t.marketCapSol.toFixed(1)} SOL`}
                progressPct={t.bondingProgressPct}
                onBuy={() => onBuyToken(t.mint)}
              />
            ))}
          </Column>

          <Column title="Almost Bonded" count={almostBonded.length}>
            {almostBonded.length === 0 && <EmptyRow text="Nothing near completion right now." />}
            {almostBonded.map((t) => (
              <TokenCard
                key={t.mint}
                symbol={t.symbol}
                name={t.name}
                mint={t.mint}
                subtitle={`${t.bondingProgressPct.toFixed(0)}% bonded · MC ${t.marketCapSol.toFixed(1)} SOL`}
                progressPct={t.bondingProgressPct}
                onBuy={() => onBuyToken(t.mint)}
              />
            ))}
          </Column>

          <Column title="Migrated" count={migrated.length}>
            {migratedError && <EmptyRow text={migratedError} />}
            {!migratedError && migrated.length === 0 && <EmptyRow text="Loading recent Raydium pools…" />}
            {migrated.map((p) => (
              <TokenCard
                key={p.poolAddress}
                symbol={p.name.split(" / ")[0]?.trim() ?? "?"}
                name={p.name}
                mint={p.tokenAddress}
                subtitle={`Liq $${(p.liquidityUsd / 1000).toFixed(1)}K · Vol $${(p.volume24hUsd / 1000).toFixed(1)}K`}
                onBuy={() => onBuyToken(p.tokenAddress)}
              />
            ))}
          </Column>
        </>
      )}
    </div>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-xs font-semibold text-[var(--text)]">{title}</span>
        <span className="font-mono text-[10px] text-[var(--text-dim)]">{count}</span>
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="glass-panel rounded-xl px-3 py-4 text-center font-mono text-[11px] text-[var(--text-dim)]">
      {text}
    </div>
  );
}
