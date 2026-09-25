"use client";

import { useEffect, useMemo, useState } from "react";
import type { HolderAnalysis, HolderInfo, HolderTag } from "@/lib/holder-analysis";

function shortAddr(addr: string) {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function tagLabel(tag: HolderTag): string {
  switch (tag) {
    case "dev":
      return "Dev";
    case "insider":
      return "Insider";
    case "sniper":
      return "Sniper";
    case "dex_pool":
      return "DEX/Pool";
    case "burned":
      return "Burned";
    default:
      return "Holder";
  }
}

function tagColor(tag: HolderTag): string {
  switch (tag) {
    case "dev":
      return "var(--accent)";
    case "insider":
    case "sniper":
      return "var(--danger)";
    case "dex_pool":
    case "burned":
      return "var(--text-dim)";
    default:
      return "var(--text-dim)";
  }
}

function RiskBadge({ holder }: { holder: HolderInfo }) {
  if (holder.tag === "unknown") return null;
  const color = tagColor(holder.tag);
  const note =
    holder.tag === "insider" && holder.fundedBy
      ? `Connected via same funder ${shortAddr(holder.fundedBy)}`
      : holder.tag === "sniper"
        ? "Bought within seconds of launch"
        : null;

  return (
    <span
      title={note ?? undefined}
      className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
      style={{ color, background: `${color}1a`, border: `1px solid ${color}40` }}
    >
      {tagLabel(holder.tag)}
    </span>
  );
}

/** Color-coded stacked bar: Top10-not-otherwise-tagged / Insiders / Burned / DEX-Pool / Free float. */
function SupplyBreakdownBar({ analysis }: { analysis: HolderAnalysis }) {
  const segments = [
    { key: "insider", label: "Insiders", pct: analysis.insiderPct, color: "var(--danger)" },
    { key: "pool", label: "DEX/Pool", pct: analysis.dexPoolPct, color: "var(--text-dim)" },
    { key: "burned", label: "Burned", pct: analysis.burnedPct, color: "#7a8296" },
    { key: "float", label: "Free Float", pct: analysis.freeFloatPct, color: "var(--success)" },
  ].filter((s) => s.pct > 0);

  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated-strong)]">
        {segments.map((s) => (
          <div key={s.key} style={{ width: `${s.pct}%`, background: s.color }} title={`${s.label} ${s.pct}%`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--text-dim)]">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
            {s.label} {s.pct}%
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricChip({ label, value, tone }: { label: string; value: string; tone?: "danger" | "success" }) {
  return (
    <div className="glass-panel flex flex-col items-center gap-0.5 rounded-xl px-2 py-2">
      <span className="font-mono text-[9px] uppercase tracking-wide text-[var(--text-dim)]">{label}</span>
      <span
        className="font-mono text-sm font-semibold"
        style={{ color: tone === "danger" ? "var(--danger)" : tone === "success" ? "var(--success)" : "var(--text)" }}
      >
        {value}
      </span>
    </div>
  );
}

function HolderRow({ holder, rank }: { holder: HolderInfo; rank: number }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-4 shrink-0 font-mono text-[10px] text-[var(--text-dim)]">{rank}</span>
        <a
          href={`https://solscan.io/account/${holder.owner}`}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-[11px] text-[var(--text)] underline decoration-[var(--border)] underline-offset-2"
        >
          {shortAddr(holder.owner)}
        </a>
        <RiskBadge holder={holder} />
      </div>
      <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--text)]">
        {holder.pctOfSupply.toFixed(2)}%
      </span>
    </div>
  );
}

async function fetchHolderAnalysisFromApi(
  mint: string,
  opts: { devWallet?: string; tokenCreatedAtMs?: number } = {}
): Promise<HolderAnalysis> {
  const params = new URLSearchParams({ mint });
  if (opts.devWallet) params.set("dev", opts.devWallet);
  if (opts.tokenCreatedAtMs) params.set("createdAt", String(opts.tokenCreatedAtMs));

  const res = await fetch(`/api/v1/holders?${params.toString()}`);
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Holder fetch failed: ${res.status}`);
  return body.analysis as HolderAnalysis;
}

export default function HolderDistributionView({
  mint,
  devWallet,
  tokenCreatedAtMs,
}: {
  mint: string;
  devWallet?: string;
  tokenCreatedAtMs?: number;
}) {
  const [analysis, setAnalysis] = useState<HolderAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setError(null);
    fetchHolderAnalysisFromApi(mint, { devWallet, tokenCreatedAtMs })
      .then((a) => {
        if (!cancelled) setAnalysis(a);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [mint, devWallet, tokenCreatedAtMs]);

  const visibleHolders = useMemo(() => {
    if (!analysis) return [];
    return expanded ? analysis.holders : analysis.holders.slice(0, 5);
  }, [analysis, expanded]);

  return (
    <div className="glass-panel rounded-2xl p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-display text-sm font-semibold">Holder Distribution</span>
        {analysis?.partial && (
          <span
            title="Full insider/sniper trace was rate-limited or skipped — tags below may be incomplete."
            className="font-mono text-[9px] text-[var(--text-dim)]"
          >
            PARTIAL
          </span>
        )}
      </div>

      {error && <div className="py-4 text-center font-mono text-[11px] text-[var(--danger)]">{error}</div>}

      {!error && !analysis && (
        <div className="py-4 text-center font-mono text-[11px] text-[var(--text-dim)]">Scanning top holders…</div>
      )}

      {analysis && (
        <>
          <SupplyBreakdownBar analysis={analysis} />

          <div className="mt-3 grid grid-cols-3 gap-2">
            <MetricChip label="Top 10" value={`${analysis.top10Pct}%`} tone={analysis.top10Pct > 50 ? "danger" : undefined} />
            <MetricChip label="Dev Holds" value={`${analysis.devPct}%`} tone={analysis.devPct > 10 ? "danger" : undefined} />
            <MetricChip
              label="Snipers"
              value={String(analysis.sniperCount)}
              tone={analysis.sniperCount > 0 ? "danger" : undefined}
            />
          </div>

          {analysis.clusters.length > 0 && (
            <div className="mt-3 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-dim)]">
                {analysis.clusters.length} funding cluster{analysis.clusters.length > 1 ? "s" : ""} detected
              </span>
              {analysis.clusters.map((c) => (
                <div key={c.id} className="rounded-lg bg-[var(--bg-elevated-strong)] px-2.5 py-1.5 font-mono text-[10px] text-[var(--text-dim)]">
                  {c.members.length} wallets funded by {shortAddr(c.funder)} · {c.pctOfSupply}% of supply
                </div>
              ))}
            </div>
          )}

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--text-dim)]">Top Holders</span>
              <span className="font-mono text-[9px] text-[var(--text-dim)]">
                {analysis.totalSupplyUi > 0 ? `Supply ${analysis.totalSupplyUi.toLocaleString()}` : null}
              </span>
            </div>
            <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl bg-[var(--bg-elevated-strong)]">
              {visibleHolders.map((h, i) => (
                <HolderRow key={h.tokenAccount} holder={h} rank={i + 1} />
              ))}
              {analysis.holders.length === 0 && (
                <div className="px-3 py-4 text-center font-mono text-[11px] text-[var(--text-dim)]">
                  No holder data returned.
                </div>
              )}
            </div>
            {analysis.holders.length > 5 && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="mt-2 w-full rounded-xl border border-[var(--border)] py-1.5 font-mono text-[10px] text-[var(--text-dim)]"
              >
                {expanded ? "Show less" : `Show all ${analysis.holders.length}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
