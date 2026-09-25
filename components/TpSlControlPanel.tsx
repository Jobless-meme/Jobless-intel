"use client";

import { useMemo, useState } from "react";
import type { WalletSigner } from "@/lib/agents-engine";
import { useTpSl, type CreateTpSlRuleInput } from "@/hooks/useTpSl";
import { LEGACY_BURNER_ID } from "@/lib/burner-vault";
import { fetchLivePricesUsd, pctChange, type TpSlOrderKind } from "@/lib/tpsl-engine";
import type { PnlCardData } from "@/lib/pnl-card-renderer";
import ClosedTradesPanel from "@/components/ClosedTradesPanel";
import PnlShareModal from "@/components/PnlShareModal";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TP_CHIPS = [100, 250, 500];
const SL_CHIPS = [-25, -50, -75];

function shortAddr(addr: string) {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function fmtPct(pct: number) {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function fmtUsd(v: number) {
  if (v >= 1) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

/** Position this panel is currently being configured for. In a real page
 * this comes from whatever row the user tapped in the holdings list —
 * plumb it in as a prop from wherever open positions are already rendered
 * (e.g. the Execution Bay's Unrealized Value module). */
export interface OpenPosition {
  walletPublicKey: string;
  /** "wallet-adapter" or a burner id from lib/burner-vault.ts. */
  signerId: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAmount: number; // UI units
  entryPriceUsd: number;
  currentPriceUsd: number;
}

export default function TpSlControlPanel({
  wallet,
  position,
}: {
  wallet: WalletSigner | null;
  position: OpenPosition | null;
}) {
  const { rules, states, createRule, cancelRule } = useTpSl(wallet);
  const [selectedTp, setSelectedTp] = useState<number[]>([]);
  const [selectedSl, setSelectedSl] = useState<number | null>(null);
  const [trailingOn, setTrailingOn] = useState(false);
  const [trailPercent, setTrailPercent] = useState(10);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<PnlCardData | null>(null);
  const [sharePreparing, setSharePreparing] = useState(false);

  const positionRules = useMemo(
    () => (position ? rules.filter((r) => r.tokenMint === position.tokenMint && r.walletPublicKey === position.walletPublicKey) : []),
    [rules, position]
  );

  async function submitRule(kind: TpSlOrderKind, targetPct?: number, trail?: number) {
    if (!position) return;
    setError(null);
    const key = `${kind}:${targetPct ?? trail}`;
    setBusy(key);
    try {
      const input: CreateTpSlRuleInput = {
        walletPublicKey: position.walletPublicKey,
        signerId: position.signerId,
        tokenMint: position.tokenMint,
        tokenSymbol: position.tokenSymbol,
        tokenDecimals: position.tokenDecimals,
        tokenAmount: position.tokenAmount,
        entryPriceUsd: position.entryPriceUsd,
        kind,
        targetPct,
        trailPercent: trail,
      };
      await createRule(input);
      if (kind === "take-profit" && targetPct != null) setSelectedTp((prev) => [...prev, targetPct]);
      if (kind === "stop-loss" && targetPct != null) setSelectedSl(targetPct);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save rule");
    } finally {
      setBusy(null);
    }
  }

  /** Live, UNREALIZED snapshot of the open position. Price comes from the
   * monitor's latest tick for any of this position's rules, else the price
   * the panel was handed. SOL PnL needs a SOL/USD quote; without one the
   * card falls back to percent-only (the modal hides the amount toggle). */
  async function handleSharePosition() {
    if (!position) return;
    setSharePreparing(true);
    try {
      const tickPrice = positionRules.map((r) => states[r.id]?.priceUsd).find((p) => typeof p === "number");
      const price = tickPrice ?? position.currentPriceUsd;
      const solUsd = (await fetchLivePricesUsd([SOL_MINT]))[SOL_MINT];
      const pnlUsd = position.tokenAmount * (price - position.entryPriceUsd);
      setShare({
        symbol: position.tokenSymbol,
        status: "open",
        priceUnit: "USD",
        entryPrice: position.entryPriceUsd,
        exitPrice: price,
        roiPct: pctChange(position.entryPriceUsd, price),
        pnlSol: solUsd ? pnlUsd / solUsd : NaN,
        costSol: solUsd ? (position.tokenAmount * position.entryPriceUsd) / solUsd : undefined,
        walletAddress: position.walletPublicKey,
      });
    } finally {
      setSharePreparing(false);
    }
  }

  async function handleCancel(id: string) {
    setBusy(id);
    try {
      await cancelRule(id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to cancel rule");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="glass-panel rounded-2xl p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
            TP / SL CONTROL DECK
          </h3>
          {position && (
            <span className="font-mono text-[10px] text-[var(--text-dim)]">
              {position.tokenSymbol} · {shortAddr(position.walletPublicKey)}
            </span>
          )}
        </div>

        {!position ? (
          <p className="font-mono text-xs text-[var(--text-dim)]">
            Select an open position to configure automated exits.
          </p>
        ) : (
          <>
            {/* Take-Profit chips */}
            <div className="mb-4 flex flex-col gap-2">
              <span className="font-mono text-xs text-[var(--text-dim)]">Take-Profit Targets</span>
              <div className="flex gap-2">
                {TP_CHIPS.map((pct) => {
                  const active = selectedTp.includes(pct);
                  const key = `take-profit:${pct}`;
                  return (
                    <button
                      key={pct}
                      type="button"
                      disabled={busy === key}
                      onClick={() => submitRule("take-profit", pct)}
                      className={`flex-1 rounded-lg border px-3 py-2 font-mono text-xs tracking-wide transition-colors disabled:opacity-50 ${
                        active
                          ? "border-[var(--success)] bg-[var(--success)]/15 text-[var(--success)]"
                          : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-elevated)]"
                      }`}
                    >
                      +{pct}%
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Stop-Loss chips */}
            <div className="mb-4 flex flex-col gap-2">
              <span className="font-mono text-xs text-[var(--text-dim)]">Stop-Loss — Hard Stop</span>
              <div className="flex gap-2">
                {SL_CHIPS.map((pct) => {
                  const active = selectedSl === pct;
                  const key = `stop-loss:${pct}`;
                  return (
                    <button
                      key={pct}
                      type="button"
                      disabled={busy === key}
                      onClick={() => submitRule("stop-loss", pct)}
                      className={`flex-1 rounded-lg border px-3 py-2 font-mono text-xs tracking-wide transition-colors disabled:opacity-50 ${
                        active
                          ? "border-[var(--danger)] bg-[var(--danger)]/15 text-[var(--danger)]"
                          : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-elevated)]"
                      }`}
                    >
                      {pct}%
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Trailing Stop toggle + step */}
            <div className="mb-1 flex flex-col gap-2 border-t border-[var(--border)] pt-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="block font-mono text-xs text-[var(--text)]">Trailing Stop-Loss</span>
                  <span className="block font-mono text-[10px] text-[var(--text-dim)]">
                    Locks in gains as price makes new highs
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={trailingOn}
                  onClick={() => setTrailingOn((v) => !v)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    trailingOn ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated-strong)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      trailingOn ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {trailingOn && (
                <>
                  <span className="mt-2 font-mono text-xs text-[var(--text-dim)]">
                    Trail Step — {trailPercent}%
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={50}
                    value={trailPercent}
                    onChange={(e) => setTrailPercent(Number(e.target.value))}
                    className="w-full accent-[var(--accent)]"
                  />
                  <button
                    type="button"
                    disabled={busy === `trailing-stop:${trailPercent}`}
                    onClick={() => submitRule("trailing-stop", undefined, trailPercent)}
                    className="lx-btn mt-2"
                  >
                    Arm {trailPercent}% Trail
                  </button>
                  <p className="mt-1 font-mono text-[9px] leading-tight text-[var(--text-dim)]">
                    Trailing stops have no fixed on-chain trigger price — they only fire while this
                    tab stays open and this monitor keeps polling.
                  </p>
                </>
              )}
            </div>

            {error && <p className="mt-3 font-mono text-[10px] text-[var(--danger)]">{error}</p>}

            <button
              type="button"
              className="lx-btn mt-4 w-full"
              disabled={sharePreparing}
              onClick={() => void handleSharePosition()}
            >
              {sharePreparing ? "Preparing card…" : "Share PnL"}
            </button>
          </>
        )}
      </div>

      {/* Active position status monitor */}
      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          ACTIVE RISK RULES
        </h3>
        {positionRules.length === 0 ? (
          <p className="font-mono text-xs text-[var(--text-dim)]">No active TP/SL rules for this position.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {positionRules.map((rule) => {
              const tick = states[rule.id];
              const pnl = tick?.pnlPct ?? 0;
              const pnlColor = pnl >= 0 ? "var(--success)" : "var(--danger)";
              const label =
                rule.kind === "take-profit"
                  ? `TP ${fmtPct(rule.targetPct ?? 0)}`
                  : rule.kind === "stop-loss"
                    ? `SL ${fmtPct(rule.targetPct ?? 0)}`
                    : `Trail ${rule.trailPercent}%`;

              return (
                <div
                  key={rule.id}
                  className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-2"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-[var(--text)]">{label}</span>
                    <span className="font-mono text-[10px] text-[var(--text-dim)]">
                      {tick
                        ? `${fmtUsd(tick.priceUsd)} · dist ${tick.distancePct.toFixed(1)}%`
                        : "awaiting price..."}
                      {rule.kind === "trailing-stop" && tick?.currentStopPriceUsd
                        ? ` · stop ${fmtUsd(tick.currentStopPriceUsd)}`
                        : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs font-semibold" style={{ color: pnlColor }}>
                      {fmtPct(pnl)}
                    </span>
                    <button
                      type="button"
                      disabled={busy === rule.id}
                      onClick={() => handleCancel(rule.id)}
                      className="font-mono text-[10px] text-[var(--text-dim)] underline decoration-dotted hover:text-[var(--danger)] disabled:opacity-50"
                    >
                      cancel
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {position?.signerId === LEGACY_BURNER_ID && (
          <p className="mt-3 font-mono text-[9px] leading-tight text-[var(--text-dim)]">
            This position's rules will exit unattended via your Copy-Trade burner wallet — no signature
            prompt when a trigger fires.
          </p>
        )}
      </div>

      {/* Exits already filled for this token (keeper-filled TP/SL, manual and batch sells) */}
      {position && (
        <ClosedTradesPanel
          walletPublicKey={position.walletPublicKey}
          mint={position.tokenMint}
          title={`CLOSED EXITS · ${position.tokenSymbol}`}
          limit={6}
        />
      )}

      <PnlShareModal open={share != null} onClose={() => setShare(null)} data={share} />
    </section>
  );
}
