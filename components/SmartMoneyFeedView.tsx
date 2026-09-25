"use client";

import { useEffect, useMemo, useState } from "react";
import { useWalletTrades } from "@/lib/pump-portal";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import {
  ACTIVITY_LABELS,
  TIER_LABELS,
  DEFAULT_SMART_MONEY_PREFS,
  buildSmartMoneyAlerts,
  fetchSmartMoneyWallets,
  addSmartMoneyWallet,
  removeSmartMoneyWallet,
  fetchWalletWinRate,
  getSmartMoneyPrefs,
  saveSmartMoneyPrefs,
  type SmartMoneyAlert,
  type SmartMoneyWallet,
  type SmartMoneyPrefs,
  type WalletTier,
  type ActivityType,
  type WalletWinRateStat,
} from "@/lib/smart-money";

function shortAddr(addr: string) {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function ageLabel(fromMs: number) {
  const s = Math.floor((Date.now() - fromMs) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function activityColor(type: ActivityType): string {
  switch (type) {
    case "whale_exit":
      return "var(--danger)";
    case "heavy_accumulation":
      return "var(--success)";
    case "smart_buy":
      return "var(--success)";
    case "smart_sell":
      return "var(--text-dim)";
  }
}

function tierColor(tier: WalletTier): string {
  switch (tier) {
    case "kol":
      return "var(--accent)";
    case "whale":
      return "var(--danger)";
    case "smart_money":
      return "var(--success)";
  }
}

/** Lazy, de-duped win-rate badge — fetches once per wallet address (see
 * the module-level cache in lib/smart-money.ts) regardless of how many
 * alert cards for that wallet are on screen. */
function WinRateBadge({ address }: { address: string }) {
  const [stat, setStat] = useState<WalletWinRateStat | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchWalletWinRate(address).then((s) => !cancelled && setStat(s));
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (stat === undefined) return <span className="font-mono text-[9px] text-[var(--text-dim)]">win rate …</span>;
  if (!stat) return null;

  const pnlTone = stat.totalRealizedSol >= 0 ? "var(--success)" : "var(--danger)";
  return (
    <span className="flex items-center gap-2 font-mono text-[9px] text-[var(--text-dim)]">
      <span>{stat.winRatePct.toFixed(0)}% win</span>
      <span style={{ color: pnlTone }}>
        {stat.totalRealizedSol >= 0 ? "+" : ""}
        {stat.totalRealizedSol.toFixed(2)} SOL realized
      </span>
    </span>
  );
}

function AlertCard({ alert, onBuy }: { alert: SmartMoneyAlert; onBuy: () => void }) {
  const color = activityColor(alert.activityType);
  return (
    <div className="glass-panel flex flex-col gap-2 rounded-xl px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="rounded-full px-1.5 py-0.5 font-mono text-[8px] font-semibold"
              style={{ color: tierColor(alert.wallet.tier), background: `${tierColor(alert.wallet.tier)}1a` }}
            >
              {TIER_LABELS[alert.wallet.tier]}
            </span>
            <span className="truncate text-sm font-medium">{alert.wallet.label}</span>
          </div>
          <a
            href={`https://solscan.io/account/${alert.wallet.address}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[10px] text-[var(--text-dim)] underline decoration-[var(--border)] underline-offset-2"
          >
            {shortAddr(alert.wallet.address)}
          </a>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
          style={{ color, background: `${color}1a`, border: `1px solid ${color}40` }}
        >
          {ACTIVITY_LABELS[alert.activityType]}
        </span>
      </div>

      <div className="flex items-center justify-between font-mono text-[10px] text-[var(--text-dim)]">
        <span>
          {alert.isBuy ? "Bought" : "Sold"} {alert.solAmount.toFixed(2)} SOL · entry{" "}
          {alert.entryPriceSol.toExponential(2)} SOL/tok
        </span>
        <span>{ageLabel(alert.timestamp)}</span>
      </div>

      <div className="flex items-center justify-between">
        <WinRateBadge address={alert.wallet.address} />
        <button
          type="button"
          onClick={onBuy}
          className="shrink-0 rounded-full bg-[var(--success)] px-3 py-1 font-mono text-[10px] font-semibold text-black"
        >
          Buy {shortAddr(alert.mint)}
        </button>
      </div>
    </div>
  );
}

function AddWalletForm({ onAdd }: { onAdd: (w: { address: string; label: string; tier: WalletTier }) => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState<WalletTier>("smart_money");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-dashed border-[var(--border)] py-2 font-mono text-[11px] text-[var(--text-dim)]"
      >
        + Track a wallet
      </button>
    );
  }

  return (
    <div className="glass-panel flex flex-col gap-2 rounded-xl p-3">
      <input
        value={address}
        onChange={(e) => setAddress(e.target.value.trim())}
        placeholder="Wallet address"
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--text)] outline-none"
      />
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label"
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none"
      />
      <div className="flex gap-1.5">
        {(["kol", "smart_money", "whale"] as WalletTier[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTier(t)}
            className="flex-1 rounded-lg px-2 py-1.5 font-mono text-[10px] font-semibold"
            style={{
              background: tier === t ? tierColor(t) : "var(--bg-elevated-strong)",
              color: tier === t ? "black" : "var(--text-dim)",
            }}
          >
            {TIER_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex-1 rounded-lg border border-[var(--border)] py-1.5 font-mono text-[11px] text-[var(--text-dim)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!address || !label}
          onClick={() => {
            onAdd({ address, label, tier });
            setAddress("");
            setLabel("");
            setTier("smart_money");
            setOpen(false);
          }}
          className="flex-1 rounded-lg bg-[var(--accent)] py-1.5 font-mono text-[11px] font-semibold text-black disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default function SmartMoneyFeedView({ onBuyToken }: { onBuyToken: (mint: string) => void }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [wallets, setWallets] = useState<SmartMoneyWallet[]>([]);
  const [prefs, setPrefs] = useState<SmartMoneyPrefs>(DEFAULT_SMART_MONEY_PREFS);
  const [loading, setLoading] = useState(true);

  // Resolve the current Supabase session (if any) so personal wallet tags
  // and prefs sync cross-device once the user has signed in via SIWS
  // elsewhere in the app — no dependency on where that happened.
  useEffect(() => {
    let cancelled = false;
    try {
      const supabase = getSupabaseBrowserClient();
      supabase.auth.getSession().then(({ data }) => {
        if (!cancelled) setUserId(data.session?.user?.id ?? null);
      });
    } catch {
      setUserId(null);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPrefs(getSmartMoneyPrefs());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSmartMoneyWallets(userId).then((w) => {
      if (!cancelled) {
        setWallets(w);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const addresses = useMemo(() => wallets.map((w) => w.address), [wallets]);
  const rawTrades = useWalletTrades(addresses, 150);
  const allAlerts = useMemo(() => buildSmartMoneyAlerts(rawTrades, wallets, 60), [rawTrades, wallets]);
  const alerts = useMemo(() => allAlerts.filter((a) => prefs.tiers.includes(a.wallet.tier)), [allAlerts, prefs.tiers]);

  function toggleTier(tier: WalletTier) {
    const next: SmartMoneyPrefs = {
      ...prefs,
      tiers: prefs.tiers.includes(tier) ? prefs.tiers.filter((t) => t !== tier) : [...prefs.tiers, tier],
    };
    setPrefs(next);
    saveSmartMoneyPrefs(userId, next);
  }

  async function handleAdd(w: { address: string; label: string; tier: WalletTier }) {
    const added = await addSmartMoneyWallet(userId, w);
    setWallets((prev) => [added, ...prev]);
  }

  async function handleRemove(w: SmartMoneyWallet) {
    await removeSmartMoneyWallet(w.id, w.address);
    setWallets((prev) => prev.filter((x) => x.address !== w.address));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {(["kol", "smart_money", "whale"] as WalletTier[]).map((t) => {
          const active = prefs.tiers.includes(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleTier(t)}
              className="rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold"
              style={{
                background: active ? `${tierColor(t)}1a` : "var(--bg-elevated-strong)",
                color: active ? tierColor(t) : "var(--text-dim)",
                border: `1px solid ${active ? `${tierColor(t)}40` : "var(--border)"}`,
              }}
            >
              {TIER_LABELS[t]}
            </button>
          );
        })}
      </div>

      {wallets.length === 0 && !loading && (
        <div className="glass-panel rounded-xl px-3 py-4 text-center font-mono text-[11px] text-[var(--text-dim)]">
          No tagged wallets yet. Add one below to start seeing smart-money alerts — no
          curated list ships pre-loaded, this feed is entirely wallets you (or your team)
          tag.
        </div>
      )}

      {wallets.length > 0 && alerts.length === 0 && (
        <div className="glass-panel rounded-xl px-3 py-4 text-center font-mono text-[11px] text-[var(--text-dim)]">
          Watching {wallets.length} wallet{wallets.length > 1 ? "s" : ""} · waiting for activity…
        </div>
      )}

      <div className="flex flex-col gap-2">
        {alerts.map((a) => (
          <AlertCard key={a.id} alert={a} onBuy={() => onBuyToken(a.mint)} />
        ))}
      </div>

      <AddWalletForm onAdd={handleAdd} />

      {wallets.length > 0 && (
        <details className="glass-panel rounded-xl p-3">
          <summary className="cursor-pointer font-mono text-[10px] text-[var(--text-dim)]">
            Manage tracked wallets ({wallets.length})
          </summary>
          <div className="mt-2 flex flex-col gap-1">
            {wallets.map((w) => (
              <div key={w.address} className="flex items-center justify-between gap-2 py-1">
                <span className="truncate font-mono text-[10px] text-[var(--text-dim)]">
                  {w.label} · {shortAddr(w.address)} {w.userId === null && "(curated)"}
                </span>
                {w.userId !== null && (
                  <button
                    type="button"
                    onClick={() => handleRemove(w)}
                    className="shrink-0 font-mono text-[10px] text-[var(--danger)]"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
