"use client";

import { useEffect, useState } from "react";
import { useWalletTrades } from "@/lib/pump-portal";
import { getTrackedWallets, addTrackedWallet, removeTrackedWallet, type TrackedWallet } from "@/lib/copy-trading";

export default function TrackView({ onBuyToken }: { onBuyToken: (mint: string) => void }) {
  const [wallets, setWallets] = useState<TrackedWallet[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => setWallets(getTrackedWallets()), []);

  const addresses = wallets.map((w) => w.address);
  const feed = useWalletTrades(addresses, 100);

  function handleAdd() {
    const addr = input.trim();
    if (!addr) return;
    setWallets(addTrackedWallet(addr));
    setInput("");
  }

  function handleRemove(addr: string) {
    setWallets(removeTrackedWallet(addr));
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-32 pt-2">
      <div className="flex items-center justify-between">
        <span className="font-display text-sm font-semibold">Wallet Tracker</span>
        <span className="font-mono text-[10px] text-[var(--text-dim)]">LIVE · pump.fun/Raydium only</span>
      </div>

      <div className="glass-panel flex gap-2 rounded-2xl p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a Solana wallet address to track"
          className="flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 font-mono text-xs font-semibold text-white"
        >
          Track
        </button>
      </div>

      {wallets.length === 0 ? (
        <div className="glass-panel rounded-2xl px-3 py-6 text-center font-mono text-xs text-[var(--text-dim)]">
          No wallets tracked yet. Add one above.
        </div>
      ) : (
        <div className="glass-panel rounded-2xl p-1">
          {wallets.map((w, i) => (
            <div key={w.address}>
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="font-mono text-xs text-[var(--text)]">
                  {w.address.slice(0, 4)}…{w.address.slice(-4)}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(w.address)}
                  className="font-mono text-[10px] text-[var(--danger)]"
                >
                  Remove
                </button>
              </div>
              {i < wallets.length - 1 && <div className="mx-3 h-px bg-[var(--border)]" />}
            </div>
          ))}
        </div>
      )}

      <div>
        <span className="mb-1.5 block font-mono text-xs font-semibold text-[var(--text)]">Live Feed</span>
        <div className="glass-panel rounded-2xl p-1">
          {feed.length === 0 && (
            <div className="px-3 py-6 text-center font-mono text-xs text-[var(--text-dim)]">
              {wallets.length === 0 ? "Track a wallet to see its trades here." : "Waiting for activity…"}
            </div>
          )}
          {feed.map((t, i) => (
            <div key={`${t.signature}-${i}`}>
              <div className="flex items-center justify-between px-3 py-2.5">
                <div>
                  <div className="font-mono text-xs">
                    <span className={t.isBuy ? "text-[var(--success)]" : "text-[var(--danger)]"}>
                      {t.isBuy ? "Buy" : "Sell"}
                    </span>{" "}
                    <span className="text-[var(--text-dim)]">
                      {t.watchedWallet.slice(0, 4)}…{t.watchedWallet.slice(-4)}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-[var(--text-dim)]">
                    {t.solAmount.toFixed(2)} SOL · MC {t.marketCapSol.toFixed(1)} SOL
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onBuyToken(t.mint)}
                  className="rounded-full bg-[var(--success)] px-3 py-1.5 font-mono text-[10px] font-semibold text-black"
                >
                  Buy
                </button>
              </div>
              {i < feed.length - 1 && <div className="mx-3 h-px bg-[var(--border)]" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
