/**
 * RugCheck.xyz — free public API for Solana token risk reports.
 * https://api.rugcheck.xyz/v1/tokens/{mint}/report
 */

export interface RugReport {
  mint: string;
  score: number; // higher = riskier, per RugCheck's own scale
  riskLevel: "low" | "medium" | "high" | "unknown";
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpLockedPct: number;
  top10HolderPct: number;
  insiderPct: number;
  risks: { name: string; description: string; level: string }[];
}

export async function fetchRugReport(mint: string): Promise<RugReport | null> {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    if (res.status === 404) return null; // not indexed by RugCheck yet
    throw new Error(`RugCheck failed: ${res.status}`);
  }
  const data = await res.json();

  // RugCheck's exact response shape has shifted across versions; parse
  // defensively and fall back to sane defaults rather than throwing.
  const top10Pct =
    Array.isArray(data.topHolders)
      ? data.topHolders.slice(0, 10).reduce((s: number, h: any) => s + (h.pct ?? 0), 0)
      : Number(data.top10HolderPercent ?? 0);

  const lpLockedPct = Number(data.markets?.[0]?.lp?.lpLockedPct ?? data.lpLockedPct ?? 0);
  const score = Number(data.score ?? data.score_normalised ?? 0);

  return {
    mint,
    score,
    riskLevel: score > 70 ? "high" : score > 35 ? "medium" : score > 0 ? "low" : "unknown",
    mintAuthorityRevoked: data.mintAuthority == null,
    freezeAuthorityRevoked: data.freezeAuthority == null,
    lpLockedPct,
    top10HolderPct: top10Pct,
    insiderPct: Number(data.insiderPercent ?? 0),
    risks: Array.isArray(data.risks)
      ? data.risks.map((r: any) => ({
          name: r.name ?? "Unknown risk",
          description: r.description ?? "",
          level: r.level ?? "info",
        }))
      : [],
  };
}

/** Concurrency-limited batch fetch — RugCheck's free tier rate-limits
 * aggressively, so don't fire 60 requests at once for a full Trenches page. */
export async function fetchRugReports(mints: string[], concurrency = 3): Promise<Record<string, RugReport | null>> {
  const out: Record<string, RugReport | null> = {};
  let idx = 0;

  async function worker() {
    while (idx < mints.length) {
      const mint = mints[idx++];
      try {
        out[mint] = await fetchRugReport(mint);
      } catch {
        out[mint] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, mints.length || 1) }, worker));
  return out;
}
