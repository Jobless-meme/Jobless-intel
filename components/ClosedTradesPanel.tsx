"use client";

import { useMemo, useState } from "react";
import { SCAN_LIMIT, closedTradeToCard, useClosedTrades, type ClosedTrade } from "@/hooks/useClosedTrades";
import { explorerTxUrl } from "@/lib/batch-trading";
import { formatRoi, formatSol, sanitizeSymbol, type PnlCardData } from "@/lib/pnl-card-renderer";
import PnlShareModal from "@/components/PnlShareModal";

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Closed trades for a wallet, each row with a Share PnL button. Used in the
 * Execution Bay (whole wallet) and in the TP/SL deck (`mint` set → just the
 * exits for that token). History is scanned on demand and shared between
 * every instance of this panel — see hooks/useClosedTrades.ts.
 */
export default function ClosedTradesPanel({
  walletPublicKey,
  mint,
  title = "CLOSED TRADES",
  limit = 12,
}: {
  walletPublicKey: string | null;
  /** Only show exits of this token. */
  mint?: string | null;
  title?: string;
  limit?: number;
}) {
  const { trades, status, progress, error, scanned, truncated, scannedAt, scan } = useClosedTrades(walletPublicKey);
  const [share, setShare] = useState<PnlCardData | null>(null);

  const visible = useMemo(
    () => (mint ? trades.filter((t) => t.mint === mint) : trades).slice(0, limit),
    [trades, mint, limit]
  );

  function openShare(t: ClosedTrade) {
    if (walletPublicKey) setShare(closedTradeToCard(t, walletPublicKey));
  }

  return (
    <div className="glass-panel rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">{title}</h3>
        <button
          type="button"
          className="lx-btn !px-3 !py-1.5"
          disabled={!walletPublicKey || status === "scanning"}
          onClick={() => scan(status === "ready")}
        >
          {status === "scanning" ? `Scanning ${Math.round(progress * 100)}%` : status === "ready" ? "Rescan" : "Scan history"}
        </button>
      </div>

      {!walletPublicKey && (
        <p className="font-mono text-xs text-[var(--text-dim)]">Connect a Solana wallet to see closed trades.</p>
      )}

      {walletPublicKey && status === "idle" && (
        <p className="font-mono text-xs text-[var(--text-dim)]">
          Reads your wallet&apos;s recent on-chain trades (about {SCAN_LIMIT} transactions). Takes a moment on public RPCs.
        </p>
      )}

      {status === "scanning" && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated-strong)]">
          <div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.max(4, progress * 100)}%` }} />
        </div>
      )}

      {error && <p className="font-mono text-[10px] text-[var(--danger)]">{error}</p>}

      {status === "ready" && visible.length === 0 && (
        <p className="font-mono text-xs text-[var(--text-dim)]">
          No closed trades found in the last {scanned} transactions.
        </p>
      )}

      {visible.length > 0 && (
        <div className="flex flex-col gap-2">
          {visible.map((t) => {
            const win = t.pnlSol >= 0;
            const color = win ? "var(--success)" : "var(--danger)";
            return (
              <div key={t.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs text-[var(--text)]">${sanitizeSymbol(t.symbol, 10)}</span>
                    {!t.eligible && (
                      <span
                        className="shrink-0 rounded border border-[var(--border)] px-1 font-mono text-[8px] text-[var(--text-dim)]"
                        title="Not counted on the leaderboard: partial history, very small size, or free tokens"
                      >
                        not ranked
                      </span>
                    )}
                  </div>
                  <a
                    href={explorerTxUrl(t.sellSignature)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10px] text-[var(--text-dim)] underline decoration-dotted"
                  >
                    {timeAgo(t.closedAt)} · tx
                  </a>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <div className="text-right">
                    <div className="font-mono text-xs font-semibold" style={{ color }}>
                      {formatRoi(t.roiPct)}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--text-dim)]">{formatSol(t.pnlSol, true)} SOL</div>
                  </div>
                  <button type="button" className="lx-btn !px-2.5 !py-1.5" onClick={() => openShare(t)}>
                    Share PnL
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {status === "ready" && scannedAt && (
        <p className="mt-3 font-mono text-[9px] leading-tight text-[var(--text-dim)]">
          Derived from your last {scanned} on-chain transactions{truncated ? " (older history not scanned)" : ""}. SOL figures are net wallet
          movement, so fees and rent are included — expect small differences from a DEX&apos;s quoted PnL.
        </p>
      )}

      <PnlShareModal open={share != null} onClose={() => setShare(null)} data={share} />
    </div>
  );
}
