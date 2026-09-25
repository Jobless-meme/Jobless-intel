"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useWalletTrades, type PumpTradeEvent } from "@/lib/pump-portal";
import {
  getTrackedWallets,
  updateTrackedWallet,
  hasBurnerWallet,
  getOrCreateBurnerWallet,
  getBurnerSigner,
  deleteBurnerWallet,
  type TrackedWallet,
} from "@/lib/copy-trading";
import { getSolBalance } from "@/lib/balances";
import { submitAutomatedTradeOrder, type LogFn } from "@/lib/agents-engine";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

export default function CopyView() {
  const { connection } = useConnection();
  const [wallets, setWallets] = useState<TrackedWallet[]>([]);
  const [burnerAddress, setBurnerAddress] = useState<string | null>(null);
  const [burnerBalance, setBurnerBalance] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const firedRef = useRef(new Set<string>()); // signatures already copied, so reconnects don't double-fire

  useEffect(() => {
    setWallets(getTrackedWallets());
    if (hasBurnerWallet()) setBurnerAddress(getOrCreateBurnerWallet().publicKey.toBase58());
  }, []);

  useEffect(() => {
    if (!burnerAddress) return;
    let cancelled = false;
    getSolBalance(connection, burnerAddress).then((b) => !cancelled && setBurnerBalance(b));
    const t = setInterval(() => getSolBalance(connection, burnerAddress).then((b) => !cancelled && setBurnerBalance(b)), 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [burnerAddress, connection]);

  const autoCopyAddresses = wallets.filter((w) => w.autoCopyEnabled).map((w) => w.address);
  const feed = useWalletTrades(autoCopyAddresses, 200);

  const pushLog: LogFn = (line) => setLogs((prev) => [...prev.slice(-99), line]);

  // Fire a mirrored buy for every new BUY event from a wallet with
  // auto-copy on, using the burner signer (no popup — that's the point).
  useEffect(() => {
    if (!burnerAddress || feed.length === 0) return;
    const latest = feed[0] as PumpTradeEvent & { watchedWallet: string };
    if (!latest.isBuy) return;
    if (firedRef.current.has(latest.signature)) return;
    firedRef.current.add(latest.signature);

    const cfg = wallets.find((w) => w.address === latest.watchedWallet);
    if (!cfg?.autoCopyEnabled) return;

    pushLog(`[COPY]: ${cfg.label ?? cfg.address.slice(0, 6)} bought ${latest.mint.slice(0, 6)}… — mirroring ${cfg.copyAmountSol} SOL`);

    const signer = getBurnerSigner(connection);
    submitAutomatedTradeOrder(
      {
        orderType: "swap",
        chain: "solana",
        inputMint: WSOL_MINT,
        outputMint: latest.mint,
        amount: String(Math.round(cfg.copyAmountSol * 1e9)),
        wallet: signer,
      },
      pushLog
    ).catch((err) => pushLog(`[COPY]: FAILED — ${err.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, burnerAddress]);

  function handleCreateBurner() {
    const kp = getOrCreateBurnerWallet();
    setBurnerAddress(kp.publicKey.toBase58());
  }

  function handleDeleteBurner() {
    if (!confirm("This deletes the local session key. Any SOL left in it becomes unrecoverable unless you've already withdrawn it. Continue?")) return;
    deleteBurnerWallet();
    setBurnerAddress(null);
    setBurnerBalance(null);
  }

  function toggleAutoCopy(address: string, enabled: boolean) {
    setWallets(updateTrackedWallet(address, { autoCopyEnabled: enabled }));
  }

  function setCopyAmount(address: string, amount: number) {
    setWallets(updateTrackedWallet(address, { copyAmountSol: amount }));
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-32 pt-2">
      <div className="flex items-center justify-between">
        <span className="font-display text-sm font-semibold">Copy Trading</span>
        <span className="font-mono text-[10px] text-[var(--text-dim)]">Executes with a local session key</span>
      </div>

      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-2 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">SESSION WALLET</h3>
        {!burnerAddress ? (
          <>
            <p className="mb-3 font-mono text-[11px] leading-relaxed text-[var(--text-dim)]">
              Auto-copy signs and sends trades with no wallet popup, which is only possible with a
              key stored in this browser. Create one, then send it a small amount of SOL — only
              what you're willing to lose if this device is compromised.
            </p>
            <button
              type="button"
              onClick={handleCreateBurner}
              className="lx-btn w-full !bg-[var(--accent)] !text-white"
            >
              Create Session Wallet
            </button>
          </>
        ) : (
          <>
            <div className="mb-1 font-mono text-xs text-[var(--text)]">
              {burnerAddress.slice(0, 6)}…{burnerAddress.slice(-6)}
            </div>
            <div className="mb-3 font-mono text-lg font-semibold">
              {burnerBalance == null ? "…" : `${burnerBalance.toFixed(4)} SOL`}
            </div>
            <button type="button" onClick={handleDeleteBurner} className="lx-btn w-full !text-[var(--danger)]">
              Delete Session Wallet
            </button>
          </>
        )}
      </div>

      <div>
        <span className="mb-1.5 block font-mono text-xs font-semibold text-[var(--text)]">Tracked Wallets</span>
        {wallets.length === 0 ? (
          <div className="glass-panel rounded-2xl px-3 py-6 text-center font-mono text-xs text-[var(--text-dim)]">
            Add wallets on the Track tab first, then enable Auto-Copy here.
          </div>
        ) : (
          <div className="glass-panel flex flex-col divide-y divide-[var(--border)] rounded-2xl p-1">
            {wallets.map((w) => (
              <div key={w.address} className="flex flex-col gap-2 px-3 py-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">
                    {w.address.slice(0, 4)}…{w.address.slice(-4)}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={w.autoCopyEnabled}
                    onClick={() => toggleAutoCopy(w.address, !w.autoCopyEnabled)}
                    disabled={!burnerAddress}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
                      w.autoCopyEnabled ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated-strong)]"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                        w.autoCopyEnabled ? "translate-x-5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-[var(--text-dim)]">Copy size</span>
                  <input
                    type="number"
                    step={0.01}
                    min={0.01}
                    value={w.copyAmountSol}
                    onChange={(e) => setCopyAmount(w.address, Number(e.target.value))}
                    className="w-20 rounded-lg border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-[11px]"
                  />
                  <span className="font-mono text-[10px] text-[var(--text-dim)]">SOL per buy</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-2 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">ACTIVITY LOG</h3>
        <div className="h-32 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-2 font-mono text-[10px] text-[var(--success)]">
          {logs.length === 0 ? <div className="text-[var(--text-dim)]">No copy trades fired yet.</div> : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}
