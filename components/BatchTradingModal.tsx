"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { PLAN_MAX_AGE_MS, useBatchTrading, type AllocationMode, type BatchPhase, type BatchWalletView } from "@/hooks/useBatchTrading";
import { useWalletSweep, type WalletSweepController } from "@/hooks/useWalletSweep";
import {
  EMERGENCY_MAX_IMPACT_PCT,
  EMERGENCY_MIN_SLIPPAGE_BPS,
  MAX_BATCH_WALLETS,
  MAX_JITTER_MS,
  MAX_STAGGER_MS,
  PRIORITY_TIER_LAMPORTS,
  explorerTxUrl,
  formatUnits,
  lamportsToSol,
  legBucket,
  shortAddress,
  summarizeLegs,
  type BatchPlan,
  type LegPreflight,
  type LegState,
  type PlannedLeg,
  type PriorityTier,
  type TimingMode,
} from "@/lib/batch-trading";
import { MAX_SWEEP_WALLETS, sweepLegBucket, type SweepLegState } from "@/lib/batch-sweep";
import type { LogFn } from "@/lib/agents-engine";

/* ------------------------------------------------------------------ */
/* Small shared bits                                                  */
/* ------------------------------------------------------------------ */

const cleanDecimal = (v: string) => {
  const c = v.replace(/[^0-9.]/g, "");
  const i = c.indexOf(".");
  return i === -1 ? c : c.slice(0, i + 1) + c.slice(i + 1).replace(/\./g, "");
};

const SLIPPAGE_CHOICES = [50, 100, 300, 500, 1000, 1500];
const IMPACT_CHOICES = [5, 10, 15, 25];

const PREFLIGHT_LABEL: Record<LegPreflight, string> = {
  ok: "READY",
  zero_amount: "NO AMOUNT",
  insufficient_sol: "LOW SOL",
  no_token_balance: "NO BALANCE",
  no_route: "NO ROUTE",
  high_impact: "HIGH IMPACT",
  quote_failed: "QUOTE ERROR",
};

function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">{children}</h3>
      {right}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-[36px] rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-40 ${
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-bright)]"
          : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-elevated)]"
      }`}
    >
      {children}
    </button>
  );
}

function AmountInput({
  value,
  onChange,
  suffix = "SOL",
  label,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  label: string;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 ${className}`}>
      <input
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(cleanDecimal(e.target.value))}
        placeholder="0.0"
        className="min-h-[42px] w-full bg-transparent font-mono text-sm text-[var(--text)] outline-none"
      />
      <span className="font-mono text-[11px] text-[var(--text-dim)]">{suffix}</span>
    </label>
  );
}

function StatusPill({ leg }: { leg: LegState }) {
  const bucket = legBucket(leg.status);
  const tone = {
    pending: "border-[var(--accent)] text-[var(--accent-bright)] animate-pulse",
    success: "border-[var(--success)] text-[var(--success)]",
    failed: "border-[var(--danger)] text-[var(--danger)]",
    skipped: "border-[var(--border)] text-[var(--text-dim)]",
  }[bucket];
  const text =
    bucket === "pending" ? "PENDING" : bucket === "success" ? "SUCCESS" : bucket === "failed" ? "FAILED" : leg.status === "cancelled" ? "CANCELLED" : "SKIPPED";
  return <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide ${tone}`}>{text}</span>;
}

function SignatureChip({ signature }: { signature: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px]">
      <a
        href={explorerTxUrl(signature)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--accent-bright)] underline underline-offset-2"
      >
        {shortAddress(signature, 8, 6)} ↗
      </a>
      <button
        type="button"
        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--text-dim)]"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(signature);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked — the link above still works */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Formats a leg's input/expected-output for either side of a batch. */
function legAmounts(plan: BatchPlan, leg: { inAmount: string; expectedOut?: string }) {
  const buy = plan.side === "buy";
  const input = buy ? `${formatUnits(leg.inAmount, 9)} SOL` : `${formatUnits(leg.inAmount, plan.mintDecimals)} tokens`;
  const output = leg.expectedOut
    ? buy
      ? `≈ ${formatUnits(leg.expectedOut, plan.mintDecimals)} tokens`
      : `≈ ${formatUnits(leg.expectedOut, 9)} SOL`
    : null;
  return { input, output };
}

function useSecondsLeft(createdAt: number, maxAgeMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((createdAt + maxAgeMs - now) / 1000));
}

/* ------------------------------------------------------------------ */
/* Modal                                                              */
/* ------------------------------------------------------------------ */

export default function BatchTradingModal({
  open,
  onClose,
  prefillMint,
  onLog,
}: {
  open: boolean;
  onClose: () => void;
  prefillMint?: string | null;
  onLog?: LogFn;
}) {
  const b = useBatchTrading({ enabled: open, onLog });
  const { actions } = b;
  const sweep = useWalletSweep(b.wallets, onLog);

  useEffect(() => {
    if (open && prefillMint && !b.mint) actions.setMint(prefillMint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillMint]);

  const running = b.phase === "running";

  // Render into <body>: the sheet is opened from inside the Settings drawer,
  // and any transformed/filtered ancestor would otherwise trap `position: fixed`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function pasteMint() {
    try {
      actions.setMint(await navigator.clipboard.readText());
    } catch {
      /* clipboard permission denied — user can still type/paste manually */
    }
  }

  function confirmDelete(id: string, label: string, balanceSol: number | null) {
    const funded = balanceSol == null || balanceSol > 0.0005;
    const msg = funded
      ? `Delete ${label}? It may still hold ${balanceSol == null ? "SOL" : `${balanceSol.toFixed(4)} SOL`}. The key is removed from this device permanently — anything left in it becomes unrecoverable.`
      : `Delete ${label}? Its key is removed from this device permanently.`;
    if (confirm(msg)) actions.deleteWallet(id);
  }

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-end justify-center bg-black/65 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Multi-wallet batch trading"
            className="relative flex max-h-[94dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-3xl border border-[var(--border)]"
            style={{ background: "var(--bg)" }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between border-b border-[var(--border)] px-4 pb-3 pt-4">
              <div>
                <div className="font-display text-sm font-semibold">Multi-Wallet Batch</div>
                <div className="font-mono text-[10px] text-[var(--text-dim)]">
                  Signs locally · keys never leave this device
                </div>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text-dim)]"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="thin-scroll flex-1 overflow-y-auto px-4 py-4">
              {b.error && (
                <div
                  role="alert"
                  className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-[var(--danger)]/50 bg-[var(--danger)]/10 px-3 py-2 font-mono text-[11px] text-[var(--danger)]"
                >
                  <span>{b.error}</span>
                  <button type="button" aria-label="Dismiss error" onClick={actions.dismissError}>
                    ✕
                  </button>
                </div>
              )}

              {(b.phase === "idle" || b.phase === "preparing") && (
                <ControlDeck b={b} sweep={sweep} pasteMint={pasteMint} confirmDelete={confirmDelete} />
              )}
              {b.phase === "review" && b.plan && <ReviewView plan={b.plan} />}
              {(b.phase === "running" || b.phase === "done") && b.plan && (
                <ProgressView plan={b.plan} legs={b.legs} phase={b.phase} retryingIds={b.retryingIds} onRetry={actions.retryLeg} />
              )}
            </div>

            {/* Footer — always visible on a phone */}
            <div className="border-t border-[var(--border)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
              {b.phase === "idle" && (
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={!b.canBuy}
                      onClick={() => actions.prepare("buy")}
                      className="lx-btn !bg-[var(--accent)] !text-white"
                    >
                      ⚡ Batch Snipe{b.deployPreviewSol > 0 ? ` · ${b.deployPreviewSol.toFixed(2)} SOL` : ""}
                    </button>
                    <button type="button" disabled={!b.canSell} onClick={() => actions.prepare("sell")} className="lx-btn">
                      Sell {b.sellPercent}%
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={!b.canEmergency}
                    onClick={() => actions.prepare("sell", { emergency: true })}
                    className="lx-btn w-full !border-[var(--danger)] !text-[var(--danger)]"
                  >
                    🚨 EMERGENCY SELL ALL
                  </button>
                </div>
              )}

              {b.phase === "preparing" && (
                <button type="button" disabled className="lx-btn w-full animate-pulse">
                  Running pre-flight — balances &amp; quotes…
                </button>
              )}

              {b.phase === "review" && b.plan && <ReviewFooter plan={b.plan} onConfirm={actions.fire} onBack={actions.cancelReview} />}

              {running && (
                <button
                  type="button"
                  disabled={b.aborting}
                  onClick={actions.abort}
                  className="lx-btn w-full !border-[var(--danger)] !text-[var(--danger)]"
                >
                  {b.aborting ? "Stopping…" : "Abort remaining wallets"}
                </button>
              )}

              {b.phase === "done" && (
                <button type="button" onClick={actions.reset} className="lx-btn w-full !bg-[var(--accent)] !text-white">
                  New batch
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Control deck (idle)                                                */
/* ------------------------------------------------------------------ */

type BatchApi = ReturnType<typeof useBatchTrading>;

function ControlDeck({
  b,
  sweep,
  pasteMint,
  confirmDelete,
}: {
  b: BatchApi;
  sweep: WalletSweepController;
  pasteMint: () => void;
  confirmDelete: (id: string, label: string, balanceSol: number | null) => void;
}) {
  const { actions } = b;
  const busy = b.phase === "preparing";
  const modes: { id: AllocationMode; label: string }[] = [
    { id: "equal", label: "Equal split" },
    { id: "fixed", label: "Fixed each" },
    { id: "custom", label: "Custom" },
  ];

  return (
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5 disabled:opacity-60">
      {/* Token */}
      <section>
        <SectionTitle>TOKEN MINT</SectionTitle>
        <div className="flex gap-2">
          <input
            value={b.mint}
            onChange={(e) => actions.setMint(e.target.value)}
            placeholder="Paste Solana token address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Token mint address"
            className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <button type="button" onClick={pasteMint} className="lx-btn">
            Paste
          </button>
        </div>
        {b.mintError && <p className="mt-1.5 font-mono text-[10px] text-[var(--danger)]">{b.mintError}</p>}
      </section>

      {/* Wallets */}
      <section>
        <SectionTitle
          right={
            <div className="flex gap-1.5">
              <button type="button" onClick={actions.selectAll} className="rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[10px] text-[var(--text-dim)]">
                All
              </button>
              <button type="button" onClick={actions.clearSelection} className="rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[10px] text-[var(--text-dim)]">
                None
              </button>
            </div>
          }
        >
          SESSION WALLETS · {b.selectedWallets.length}/{b.wallets.length} SELECTED
        </SectionTitle>

        {b.wallets.length === 0 ? (
          <p className="mb-2 rounded-xl border border-dashed border-[var(--border)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-dim)]">
            No session wallets yet. Create some, then send each a small amount of SOL — only what you&apos;re willing to
            lose if this device is compromised. Keys are stored in this browser only.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {b.wallets.map((w) => {
              const selected = b.selectedIds.includes(w.id);
              return (
                <div key={w.id}>
                  <div className="flex items-stretch gap-2">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      onClick={() => actions.toggleWallet(w.id)}
                      className={`flex min-h-[52px] min-w-0 flex-1 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                        selected ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--bg-elevated)]"
                      }`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                          selected ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--border)]"
                        }`}
                      >
                        {selected ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 font-mono text-xs text-[var(--text)]">
                          <span className="truncate">{w.label}</span>
                          {w.legacy && (
                            <span className="rounded border border-[var(--border)] px-1 text-[9px] text-[var(--text-dim)]">COPY</span>
                          )}
                        </span>
                        <span className="block font-mono text-[10px] text-[var(--text-dim)]">{shortAddress(w.publicKey, 4, 4)}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-[var(--text)]">
                        {w.balanceSol == null ? "…" : `${w.balanceSol.toFixed(4)} SOL`}
                      </span>
                    </button>
                    {!w.legacy && (
                      <button
                        type="button"
                        aria-label={`Delete ${w.label}`}
                        onClick={() => confirmDelete(w.id, w.label, w.balanceSol)}
                        className="w-10 shrink-0 rounded-xl border border-[var(--border)] text-[var(--text-dim)] hover:text-[var(--danger)]"
                      >
                        🗑
                      </button>
                    )}
                  </div>
                  {b.allocationMode === "custom" && selected && (
                    <AmountInput
                      label={`SOL for ${w.label}`}
                      value={b.customSol[w.id] ?? ""}
                      onChange={(v) => actions.setCustomSol(w.id, v)}
                      className="ml-8 mt-1.5"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          onClick={actions.createWallet}
          disabled={b.wallets.length >= MAX_BATCH_WALLETS}
          className="lx-btn mt-2 w-full"
        >
          + New session wallet
        </button>
      </section>

      {/* Sweep */}
      <SweepPanel sweep={sweep} wallets={b.wallets} />

      {/* Allocation */}
      <section>
        <SectionTitle>BUY ALLOCATION</SectionTitle>
        <div className="mb-2 grid grid-cols-3 gap-2">
          {modes.map((m) => (
            <Chip key={m.id} active={b.allocationMode === m.id} onClick={() => actions.setConfig({ allocationMode: m.id })}>
              {m.label}
            </Chip>
          ))}
        </div>

        {b.allocationMode === "equal" && (
          <AmountInput label="Total SOL to deploy" value={b.totalSol} onChange={(v) => actions.setConfig({ totalSol: v })} />
        )}
        {b.allocationMode === "fixed" && (
          <AmountInput label="SOL per wallet" value={b.perWalletSol} onChange={(v) => actions.setConfig({ perWalletSol: v })} suffix="SOL / wallet" />
        )}
        {b.allocationMode === "custom" && (
          <p className="font-mono text-[10px] text-[var(--text-dim)]">Enter an amount under each selected wallet above.</p>
        )}
        <p className="mt-1.5 font-mono text-[10px] text-[var(--text-dim)]">
          Deploys {b.deployPreviewSol.toFixed(4)} SOL across {b.selectedWallets.length} wallet{b.selectedWallets.length === 1 ? "" : "s"}
          {b.allocationMode === "equal" && b.selectedWallets.length > 0 && b.deployPreviewSol > 0
            ? ` (≈ ${(b.deployPreviewSol / b.selectedWallets.length).toFixed(4)} each)`
            : ""}
          .
        </p>
      </section>

      {/* Sell size */}
      <section>
        <SectionTitle>SELL SIZE (% OF EACH WALLET&apos;S BALANCE)</SectionTitle>
        <div className="grid grid-cols-4 gap-2">
          {[25, 50, 75, 100].map((p) => (
            <Chip key={p} active={b.sellPercent === p} onClick={() => actions.setConfig({ sellPercent: p })}>
              {p}%
            </Chip>
          ))}
        </div>
      </section>

      {/* Advanced */}
      <details className="group rounded-xl border border-[var(--border)]">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          <span>EXECUTION SETTINGS</span>
          <span className="text-[10px] normal-case tracking-normal">
            {(b.effectiveSlippageBps / 100).toFixed(1)}% slip · {b.priorityTier} · {b.timing.mode}
          </span>
        </summary>

        <div className="flex flex-col gap-4 border-t border-[var(--border)] p-3">
          <div>
            <SectionTitle>SLIPPAGE (OVERRIDES QUICK BUY PRESET)</SectionTitle>
            <div className="flex flex-wrap gap-2">
              <Chip active={b.slippageOverrideBps == null} onClick={() => actions.setConfig({ slippageOverrideBps: null })}>
                Preset ({(b.presetSlippageBps / 100).toFixed(1)}%)
              </Chip>
              {SLIPPAGE_CHOICES.map((bps) => (
                <Chip key={bps} active={b.slippageOverrideBps === bps} onClick={() => actions.setConfig({ slippageOverrideBps: bps })}>
                  {bps / 100}%
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <SectionTitle>PRIORITY FEE (PER WALLET)</SectionTitle>
            <div className="grid grid-cols-3 gap-2">
              {(["standard", "fast", "turbo"] as PriorityTier[]).map((t) => (
                <Chip key={t} active={b.priorityTier === t} onClick={() => actions.setConfig({ priorityTier: t })}>
                  <span className="block uppercase">{t}</span>
                  <span className="block text-[9px] opacity-70">{lamportsToSol(PRIORITY_TIER_LAMPORTS[t])} SOL</span>
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <SectionTitle>TIMING</SectionTitle>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["simultaneous", "Together"],
                  ["stagger", "Stagger"],
                  ["jitter", "Jitter"],
                ] as [TimingMode, string][]
              ).map(([mode, label]) => (
                <Chip key={mode} active={b.timing.mode === mode} onClick={() => actions.setTiming({ mode })}>
                  {label}
                </Chip>
              ))}
            </div>

            {b.timing.mode !== "simultaneous" && (
              <div className="mt-3 flex flex-col gap-3">
                <Slider
                  label={`Gap between wallets — ${b.timing.staggerMs}ms`}
                  min={100}
                  max={MAX_STAGGER_MS}
                  step={100}
                  value={b.timing.staggerMs}
                  onChange={(v) => actions.setTiming({ staggerMs: v })}
                />
                {b.timing.mode === "jitter" && (
                  <Slider
                    label={`Random wobble ± ${b.timing.jitterMs}ms`}
                    min={0}
                    max={MAX_JITTER_MS}
                    step={100}
                    value={b.timing.jitterMs}
                    onChange={(v) => actions.setTiming({ jitterMs: v })}
                  />
                )}
              </div>
            )}

            {b.allocationMode === "equal" && (
              <div className="mt-3">
                <Slider
                  label={`Size variation ± ${b.timing.amountJitterPct}% (total stays exact)`}
                  min={0}
                  max={25}
                  step={1}
                  value={b.timing.amountJitterPct}
                  onChange={(v) => actions.setTiming({ amountJitterPct: v })}
                />
              </div>
            )}

            <p className="mt-2 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
              Spacing and size variation stop identical orders landing in the same slot. They don&apos;t hide that these
              wallets share a funding source.
            </p>
          </div>

          <div>
            <SectionTitle>MAX PRICE IMPACT PER WALLET</SectionTitle>
            <div className="grid grid-cols-4 gap-2">
              {IMPACT_CHOICES.map((p) => (
                <Chip key={p} active={b.maxPriceImpactPct === p} onClick={() => actions.setConfig({ maxPriceImpactPct: p })}>
                  {p}%
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </details>
    </fieldset>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] text-[var(--text-dim)]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Sweep (withdraw SOL from session wallets)                          */
/* ------------------------------------------------------------------ */

function SweepPanel({ sweep, wallets }: { sweep: WalletSweepController; wallets: BatchWalletView[] }) {
  const { actions } = sweep;
  const busy = sweep.phase === "preparing";

  if (sweep.phase === "running" || sweep.phase === "done") {
    return (
      <section className="rounded-xl border border-[var(--border)] p-3">
        <SectionTitle>SWEEP WALLETS</SectionTitle>
        <SweepProgress legs={sweep.legs} />
        {sweep.error && <p className="mt-2 font-mono text-[11px] text-[var(--danger)]">{sweep.error}</p>}
        {sweep.phase === "done" && (
          <button type="button" onClick={actions.reset} className="lx-btn mt-3 w-full">
            Done
          </button>
        )}
      </section>
    );
  }

  if (sweep.phase === "review" && sweep.plan) {
    const plan = sweep.plan;
    return (
      <section className="rounded-xl border border-[var(--border)] p-3">
        <SectionTitle>SWEEP WALLETS · REVIEW</SectionTitle>
        <p className="mb-2 font-mono text-[11px] text-[var(--text-dim)]">
          Sending {lamportsToSol(plan.totals.totalLamports).toFixed(4)} SOL from {plan.totals.executable} wallet
          {plan.totals.executable === 1 ? "" : "s"} to {shortAddress(plan.destination, 6, 4)}.
        </p>
        <div className="flex flex-col gap-2">
          {plan.legs.map((leg) => (
            <div
              key={leg.walletId}
              className={`rounded-xl border p-2.5 ${
                leg.preflight === "ok" ? "border-[var(--border)]" : "border-[var(--danger)]/40 bg-[var(--danger)]/5"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-[var(--text)]">{leg.label}</span>
                <span className="font-mono text-xs text-[var(--text-dim)]">
                  {leg.preflight === "ok" ? `${lamportsToSol(leg.sweepLamports).toFixed(4)} SOL` : "—"}
                </span>
              </div>
              {leg.issue && <div className="mt-1 font-mono text-[10px] text-[var(--danger)]">{leg.issue}</div>}
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-[1fr_2fr] gap-2">
          <button type="button" onClick={actions.cancelReview} className="lx-btn">
            Back
          </button>
          <button
            type="button"
            disabled={plan.totals.executable === 0}
            onClick={actions.confirm}
            className="lx-btn !bg-[var(--accent)] !text-white"
          >
            Confirm sweep · {plan.totals.executable} wallet{plan.totals.executable === 1 ? "" : "s"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <details className="group rounded-xl border border-[var(--border)]">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
        <span>SWEEP WALLETS</span>
        <span className="text-[10px] normal-case tracking-normal">{sweep.selectedIds.length} selected</span>
      </summary>

      <fieldset disabled={busy} className="flex flex-col gap-4 border-t border-[var(--border)] p-3 disabled:opacity-60">
        {sweep.error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-xl border border-[var(--danger)]/50 bg-[var(--danger)]/10 px-3 py-2 font-mono text-[11px] text-[var(--danger)]"
          >
            <span>{sweep.error}</span>
            <button type="button" aria-label="Dismiss error" onClick={actions.dismissError}>
              ✕
            </button>
          </div>
        )}

        <p className="font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
          Drains native SOL from session wallets straight back to your main wallet — one local signature per wallet,
          nothing else moves.
        </p>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="font-mono text-[10px] text-[var(--text-dim)]">WALLETS</span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={actions.selectAll}
                className="rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[10px] text-[var(--text-dim)]"
              >
                All
              </button>
              <button
                type="button"
                onClick={actions.clearSelection}
                className="rounded-md border border-[var(--border)] px-2 py-1 font-mono text-[10px] text-[var(--text-dim)]"
              >
                None
              </button>
            </div>
          </div>
          {wallets.length === 0 ? (
            <p className="font-mono text-[11px] text-[var(--text-dim)]">No session wallets yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {wallets.map((w) => {
                const selected = sweep.selectedIds.includes(w.id);
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    onClick={() => actions.toggleWallet(w.id)}
                    className={`flex min-h-[44px] items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${
                      selected ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--bg-elevated)]"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] ${
                        selected ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--border)]"
                      }`}
                    >
                      {selected ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text)]">{w.label}</span>
                    <span className="shrink-0 font-mono text-xs text-[var(--text)]">
                      {w.balanceSol == null ? "…" : `${w.balanceSol.toFixed(4)} SOL`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <span className="mb-1.5 block font-mono text-[10px] text-[var(--text-dim)]">DESTINATION · MAIN WALLET</span>
          <input
            value={sweep.destination}
            onChange={(e) => sweep.setDestination(e.target.value)}
            placeholder={sweep.effectiveDestination || "Paste destination address"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Sweep destination address"
            className="min-h-[42px] w-full rounded-lg border border-[var(--border)] bg-transparent px-3 font-mono text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          {sweep.destinationError && <p className="mt-1.5 font-mono text-[10px] text-[var(--danger)]">{sweep.destinationError}</p>}
        </div>

        <div>
          <span className="mb-1.5 block font-mono text-[10px] text-[var(--text-dim)]">LEAVE BEHIND</span>
          <div className="grid grid-cols-2 gap-2">
            <Chip active={sweep.mode === "dust"} onClick={() => sweep.setMode("dust")}>
              Rent-exempt dust
            </Chip>
            <Chip active={sweep.mode === "empty"} onClick={() => sweep.setMode("empty")}>
              Empty completely
            </Chip>
          </div>
          <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
            {sweep.mode === "dust"
              ? "Keeps each wallet's rent-exempt minimum (~0.0009 SOL) so it stays a usable account without a fresh top-up."
              : "Drains every wallet to exactly 0 SOL. It'll need fresh SOL before it can sign anything again."}
          </p>
        </div>

        <button
          type="button"
          disabled={sweep.selectedIds.length === 0 || !!sweep.destinationError || !sweep.effectiveDestination}
          onClick={actions.prepare}
          className="lx-btn w-full"
        >
          {busy ? "Reading balances…" : `Review sweep · ${sweep.selectedIds.length}/${Math.min(wallets.length, MAX_SWEEP_WALLETS)} wallet(s)`}
        </button>
      </fieldset>
    </details>
  );
}

function SweepProgress({ legs }: { legs: SweepLegState[] }) {
  const counts = { pending: 0, success: 0, failed: 0, skipped: 0 };
  for (const l of legs) counts[sweepLegBucket(l.status)]++;
  const finished = counts.success + counts.failed + counts.skipped;

  return (
    <div className="flex flex-col gap-2">
      <div className="font-mono text-[11px] text-[var(--text-dim)]">
        {finished}/{legs.length} done · {counts.success} swept
        {counts.failed > 0 ? ` · ${counts.failed} failed` : ""}
      </div>
      {legs.map((leg) => (
        <div key={leg.walletId} className="rounded-xl border border-[var(--border)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-xs text-[var(--text)]">{leg.label}</span>
            <SweepStatusPill leg={leg} />
          </div>
          {leg.sweepLamports > 0 && (
            <div className="mt-1 font-mono text-[11px] text-[var(--text-dim)]">{lamportsToSol(leg.sweepLamports).toFixed(4)} SOL</div>
          )}
          {leg.stage && <div className="mt-1 font-mono text-[10px] text-[var(--accent-bright)]">{leg.stage}…</div>}
          {leg.signature && <SignatureChip signature={leg.signature} />}
          {leg.error && <div className="mt-1 font-mono text-[10px] text-[var(--danger)]">{leg.error}</div>}
        </div>
      ))}
    </div>
  );
}

function SweepStatusPill({ leg }: { leg: SweepLegState }) {
  const bucket = sweepLegBucket(leg.status);
  const tone = {
    pending: "border-[var(--accent)] text-[var(--accent-bright)] animate-pulse",
    success: "border-[var(--success)] text-[var(--success)]",
    failed: "border-[var(--danger)] text-[var(--danger)]",
    skipped: "border-[var(--border)] text-[var(--text-dim)]",
  }[bucket];
  const text =
    bucket === "pending" ? "PENDING" : bucket === "success" ? "SUCCESS" : bucket === "failed" ? "FAILED" : leg.status === "cancelled" ? "CANCELLED" : "SKIPPED";
  return <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide ${tone}`}>{text}</span>;
}

/* ------------------------------------------------------------------ */
/* Review                                                             */
/* ------------------------------------------------------------------ */

function ReviewView({ plan }: { plan: BatchPlan }) {
  const buy = plan.side === "buy";
  const secondsLeft = useSecondsLeft(plan.createdAt, PLAN_MAX_AGE_MS);
  const { timing } = plan.settings;

  return (
    <div className="flex flex-col gap-4">
      {plan.emergency && (
        <div className="rounded-xl border border-[var(--danger)]/60 bg-[var(--danger)]/10 p-3 font-mono text-[11px] leading-relaxed text-[var(--danger)]">
          EMERGENCY SELL — sells 100% of every listed wallet at turbo priority, slippage raised to at least{" "}
          {EMERGENCY_MIN_SLIPPAGE_BPS / 100}%, and price-impact cap relaxed to {EMERGENCY_MAX_IMPACT_PCT}%. You may
          receive noticeably less than the quoted price.
        </div>
      )}

      <div className="glass-panel rounded-2xl p-4">
        <div className="font-display text-base font-semibold">
          {buy ? "Buy" : plan.emergency ? "Emergency sell" : `Sell ${plan.sellPercent ?? 100}%`} · {shortAddress(plan.mint, 6, 4)}
        </div>
        <div className="mt-1 font-mono text-[11px] text-[var(--text-dim)]">
          {buy
            ? `${lamportsToSol(plan.totals.deployLamports).toFixed(4)} SOL across ${plan.totals.executable} wallet${plan.totals.executable === 1 ? "" : "s"}`
            : `${plan.totals.executable} wallet${plan.totals.executable === 1 ? "" : "s"} selling`}
        </div>
        <div className="mt-2 font-mono text-[10px] text-[var(--text-dim)]">
          {(plan.settings.slippageBps / 100).toFixed(1)}% slippage · {plan.settings.priorityTier} priority ·{" "}
          {timing.mode === "simultaneous" ? "all at once" : `${timing.mode}, ${timing.staggerMs}ms gaps`}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {plan.legs.map((leg) => (
          <PlannedLegRow key={leg.walletId} plan={plan} leg={leg} />
        ))}
      </div>

      {plan.totals.flagged > 0 && plan.totals.executable > 0 && (
        <p className="font-mono text-[11px] text-[var(--accent-bright)]">
          {plan.totals.flagged} flagged wallet{plan.totals.flagged === 1 ? "" : "s"} will be skipped — the rest still
          execute{buy ? ", so less than your full amount will be deployed" : ""}.
        </p>
      )}
      {plan.totals.executable === 0 && (
        <p className="font-mono text-[11px] text-[var(--danger)]">
          No wallet cleared pre-flight. Go back, fix the flagged items (fund wallets, lower size, or raise the impact
          limit) and try again.
        </p>
      )}
      <p className="font-mono text-[10px] text-[var(--text-dim)]">
        {secondsLeft > 0 ? `Prices and balances are held for ${secondsLeft}s.` : "This review has expired — go back and run it again."}
      </p>
    </div>
  );
}

function PlannedLegRow({ plan, leg }: { plan: BatchPlan; leg: PlannedLeg }) {
  const { input, output } = legAmounts(plan, leg);
  const ok = leg.preflight === "ok";
  return (
    <div className={`rounded-xl border p-3 ${ok ? "border-[var(--border)]" : "border-[var(--danger)]/40 bg-[var(--danger)]/5"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-[var(--text)]">{leg.label}</span>
        <span
          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide ${
            ok ? "border-[var(--success)] text-[var(--success)]" : "border-[var(--danger)] text-[var(--danger)]"
          }`}
        >
          {PREFLIGHT_LABEL[leg.preflight]}
        </span>
      </div>
      {leg.inAmount !== "0" && (
        <div className="mt-1 font-mono text-[11px] text-[var(--text-dim)]">
          {input}
          {output ? ` → ${output}` : ""}
        </div>
      )}
      {ok && (
        <div className="mt-0.5 font-mono text-[10px] text-[var(--text-dim)]">
          {leg.priceImpactPct != null ? `impact ${leg.priceImpactPct.toFixed(2)}%` : ""}
          {leg.delayMs > 0 ? ` · fires at +${(leg.delayMs / 1000).toFixed(1)}s` : ""}
        </div>
      )}
      {leg.issue && <div className="mt-1 font-mono text-[10px] text-[var(--danger)]">{leg.issue}</div>}
    </div>
  );
}

function ReviewFooter({ plan, onConfirm, onBack }: { plan: BatchPlan; onConfirm: () => void; onBack: () => void }) {
  const secondsLeft = useSecondsLeft(plan.createdAt, PLAN_MAX_AGE_MS);
  const canConfirm = plan.totals.executable > 0 && secondsLeft > 0;
  return (
    <div className="grid grid-cols-[1fr_2fr] gap-2">
      <button type="button" onClick={onBack} className="lx-btn">
        Back
      </button>
      <button
        type="button"
        disabled={!canConfirm}
        onClick={onConfirm}
        className={`lx-btn ${plan.emergency ? "!bg-[var(--danger)]" : "!bg-[var(--accent)]"} !text-white`}
      >
        {plan.emergency ? "Confirm emergency sell" : plan.side === "buy" ? "Confirm & snipe" : "Confirm sell"} ·{" "}
        {plan.totals.executable} wallet{plan.totals.executable === 1 ? "" : "s"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live progress                                                      */
/* ------------------------------------------------------------------ */

function ProgressView({
  plan,
  legs,
  phase,
  retryingIds,
  onRetry,
}: {
  plan: BatchPlan;
  legs: LegState[];
  phase: BatchPhase;
  retryingIds: string[];
  onRetry: (walletId: string) => void;
}) {
  const counts = summarizeLegs(legs);
  const total = legs.length || 1;
  const finished = counts.success + counts.failed + counts.skipped;
  const allDone = counts.pending === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <span className="font-display text-sm font-semibold">
            {allDone ? "Batch finished" : plan.side === "buy" ? "Sniping…" : "Selling…"}
          </span>
          <span className="font-mono text-xs text-[var(--text-dim)]">
            {finished}/{legs.length}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated-strong)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: `${(finished / total) * 100}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px]">
          <span className="text-[var(--success)]">✓ {counts.success} success</span>
          <span className="text-[var(--danger)]">✕ {counts.failed} failed</span>
          <span className="text-[var(--accent-bright)]">◔ {counts.pending} pending</span>
          {counts.skipped > 0 && <span className="text-[var(--text-dim)]">– {counts.skipped} skipped</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {legs.map((leg) => {
          const { input, output } = legAmounts(plan, leg);
          return (
            <div key={leg.walletId} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-[var(--text)]">{leg.label}</span>
                <StatusPill leg={leg} />
              </div>
              {leg.inAmount !== "0" && (
                <div className="mt-1 font-mono text-[11px] text-[var(--text-dim)]">
                  {input}
                  {output ? ` → ${output}` : ""}
                </div>
              )}
              {leg.stage && <div className="mt-1 font-mono text-[10px] text-[var(--accent-bright)]">{leg.stage}…</div>}
              {leg.signature && <SignatureChip signature={leg.signature} />}
              {leg.error && <div className="mt-1 font-mono text-[10px] text-[var(--danger)]">{leg.error}</div>}
              {phase === "done" && leg.status === "failed" && (
                <button
                  type="button"
                  disabled={retryingIds.includes(leg.walletId)}
                  onClick={() => onRetry(leg.walletId)}
                  className="mt-2 w-full rounded-lg border border-[var(--accent)] py-1.5 font-mono text-[10px] text-[var(--accent-bright)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50"
                >
                  {retryingIds.includes(leg.walletId) ? "Retrying…" : "↻ Retry this wallet"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
