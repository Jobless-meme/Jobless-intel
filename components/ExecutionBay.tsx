"use client";

import { useEffect, useRef, useState } from "react";
import { submitAutomatedTradeOrder, type WalletSigner } from "@/lib/agents-engine";
import BatchTradingModal from "@/components/BatchTradingModal";
import ClosedTradesPanel from "@/components/ClosedTradesPanel";
import LeaderboardPanel from "@/components/LeaderboardPanel";

/* ------------------------------------------------------------------ */
/* The 15 Execution Bay tools                                         */
/* ------------------------------------------------------------------ */
const EXECUTION_MODULES: { id: string; label: string; icon: string; desc: string }[] = [
  { id: "execute-swap-order", label: "Instant Swap", icon: "⇄", desc: "Solana + BSC market swap" },
  { id: "multi-wallet-batch", label: "Multi-Wallet Batch", icon: "▤", desc: "Snipe / sell across up to 10 session wallets" },
  { id: "priority-gas-booster", label: "Priority Gas Booster", icon: "⚡", desc: "CU price / gwei tiers" },
  { id: "jito-mev-bundle-shield", label: "Jito MEV Shield", icon: "🛡", desc: "Private bundle routing" },
  { id: "limit-order-scheduler", label: "Limit Order", icon: "⌖", desc: "Trigger at target price" },
  { id: "take-profit-trigger", label: "Take-Profit", icon: "▲", desc: "Auto-exit on upside" },
  { id: "stop-loss-guard", label: "Stop-Loss Guard", icon: "▼", desc: "Auto-exit on downside" },
  { id: "trailing-stop-loss-engine", label: "Trailing Stop", icon: "↝", desc: "High-water-mark ceiling" },
  { id: "dca-dollar-cost-averaging-scheduler", label: "DCA Scheduler", icon: "⟳", desc: "Recurring buy queue" },
  { id: "mev-sandwich-protection", label: "Sandwich Protection", icon: "⛨", desc: "Anti front-run routing" },
  { id: "sandwich-bot-exploit-revenue-share", label: "Shield Analytics", icon: "◈", desc: "Volume shielded / saved" },
  { id: "slippage-auto-optimizer", label: "Slippage Optimizer", icon: "≋", desc: "Depth-aware slippage" },
  { id: "robinhood-connect-fiat-onramp", label: "Fiat On-Ramp", icon: "$", desc: "Robinhood Connect" },
  { id: "wallet-pnl-realized-analytics", label: "Realized PnL", icon: "Σ", desc: "FIFO cost-basis PnL" },
  { id: "wallet-unrealized-valuation", label: "Unrealized Value", icon: "◎", desc: "Live holdings valuation" },
];

type GasMode = "standard" | "fast" | "turbo";

export default function ExecutionBay({
  wallet,
  prefillOutputMint,
}: {
  wallet: WalletSigner | null;
  prefillOutputMint?: string | null;
}) {
  const [activeModule, setActiveModule] = useState<string | null>(null);
  const [gasMode, setGasMode] = useState<GasMode>("standard");
  const [jitoShield, setJitoShield] = useState(false);
  const [trailPercent, setTrailPercent] = useState(5);
  const [logs, setLogs] = useState<string[]>(["[ENGINE]: Execution Bay idle."]);
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  function pushLog(line: string) {
    setLogs((prev) => [...prev.slice(-199), line]);
    queueMicrotask(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }));
  }

  async function handleManualExecute(orderType: "swap" | "limit" | "take-profit" | "stop-loss" | "trailing-stop") {
    if (!wallet) {
      pushLog("[ENGINE]: No wallet connected — aborting.");
      return;
    }
    setBusy(true);
    try {
      const form = document.getElementById("lxManualOrderForm") as HTMLFormElement | null;
      const fd = form ? new FormData(form) : new FormData();
      const inputMint = String(fd.get("inputMint") || "");
      const outputMint = String(fd.get("outputMint") || "");
      const amount = String(fd.get("amount") || "0");
      const takingAmount = String(fd.get("takingAmount") || "") || undefined;

      await submitAutomatedTradeOrder(
        {
          orderType,
          chain: wallet.chain,
          inputMint,
          outputMint,
          amount,
          takingAmount,
          gasMode,
          jitoShield,
          trailPercent,
          entryPrice: Number(fd.get("entryPrice") || 0) || undefined,
          wallet,
        },
        pushLog
      );
    } catch (err: any) {
      pushLog(`[ENGINE]: FAILED — ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-5">
      {/* Control Center — left column */}
      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          CONTROL CENTER
        </h3>

        <div className="mb-4 flex flex-col gap-2">
          <span className="font-mono text-xs text-[var(--text-dim)]">Priority Fee</span>
          <div className="flex gap-2">
            {(["standard", "fast", "turbo"] as GasMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setGasMode(m)}
                className={`flex-1 rounded-lg border px-3 py-2 font-mono text-xs uppercase tracking-wide transition-colors ${
                  gasMode === m
                    ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-bright)]"
                    : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-elevated)]"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between">
          <div>
            <span className="block font-mono text-xs text-[var(--text)]">Jito MEV Shield</span>
            <span className="block font-mono text-[10px] text-[var(--text-dim)]">Private bundle routing</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={jitoShield}
            onClick={() => setJitoShield((v) => !v)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              jitoShield ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated-strong)]"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                jitoShield ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="mb-1 flex flex-col gap-2">
          <span className="font-mono text-xs text-[var(--text-dim)]">
            Trailing Stop Bound — {trailPercent}%
          </span>
          <input
            type="range"
            min={1}
            max={50}
            value={trailPercent}
            onChange={(e) => setTrailPercent(Number(e.target.value))}
            className="w-full accent-[var(--accent)]"
          />
        </div>
      </div>

      {/* Manual order form */}
      <form id="lxManualOrderForm" className="glass-panel flex flex-col gap-2 rounded-2xl p-4">
        <h3 className="mb-1 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          MANUAL EXECUTION
        </h3>
        <input
          name="inputMint"
          placeholder="Input mint / token address"
          className="rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
        />
        <input
          name="outputMint"
          placeholder="Output mint / token address"
          className="rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
        />
        <div className="flex gap-2">
          <input
            name="amount"
            placeholder="Amount (base units)"
            className="w-1/2 rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
          />
          <input
            name="takingAmount"
            placeholder="Target amount (limit/TP/SL)"
            className="w-1/2 rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
          />
        </div>
        <input
          name="entryPrice"
          placeholder="Entry price (trailing stop only)"
          className="rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
        />
        <div className="mt-1 grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => handleManualExecute("swap")} className="lx-btn">
            Swap Now
          </button>
          <button type="button" disabled={busy} onClick={() => handleManualExecute("limit")} className="lx-btn">
            Limit Order
          </button>
          <button type="button" disabled={busy} onClick={() => handleManualExecute("take-profit")} className="lx-btn">
            Take-Profit
          </button>
          <button type="button" disabled={busy} onClick={() => handleManualExecute("stop-loss")} className="lx-btn">
            Stop-Loss
          </button>
        </div>
      </form>

      {/* Execution Bay module grid */}
      <div id="lxViewEngine" className="glass-panel rounded-2xl p-4">
        <h3 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          AUTOMATED EXECUTION BAY
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {EXECUTION_MODULES.map((mod) => (
            <button
              key={mod.id}
              type="button"
              className={`lx-mod flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors ${
                activeModule === mod.id
                  ? "border-[var(--accent)] bg-[var(--accent)]/10"
                  : "border-[var(--border)] hover:bg-[var(--bg-elevated)]"
              }`}
              data-tool={mod.id}
              onClick={() => {
                setActiveModule(mod.id);
                if (mod.id === "multi-wallet-batch") {
                  setBatchOpen(true);
                } else {
                  pushLog(`[ENGINE]: ${mod.label} selected.`);
                }
              }}
            >
              <span className="text-lg">{mod.icon}</span>
              <span className="font-mono text-[10px] leading-tight text-[var(--text)]">{mod.label}</span>
              <span className="font-mono text-[9px] leading-tight text-[var(--text-dim)]">{mod.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Live terminal log */}
      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-2 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          TERMINAL LOG
        </h3>
        <div
          id="terminalAiLog"
          className="h-40 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-2 font-mono text-[11px] text-[var(--success)]"
        >
          {logs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* Slice 9 — closed trades (Share PnL) + community leaderboard */}
      <ClosedTradesPanel walletPublicKey={wallet?.chain === "solana" ? wallet.publicKey : null} />
      <LeaderboardPanel />

      <BatchTradingModal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        prefillMint={prefillOutputMint}
        onLog={pushLog}
      />
    </section>
  );
}
