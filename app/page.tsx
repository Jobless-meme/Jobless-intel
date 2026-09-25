"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useAccount, useConnect, useDisconnect, usePublicClient } from "wagmi";
import { fetchLiveChart, type Candle, type ChartNetwork, type Timeframe } from "@/lib/chart-feed";
import { fetchTrendingFeed, type TrendingToken } from "@/lib/trending";
import { useAppWalletSigner } from "@/lib/wallet-signer";
import { useAppEvmWalletSigner } from "@/lib/evm-wallet-signer";
import { submitAutomatedTradeOrder } from "@/lib/agents-engine";
import { useWalletAuth } from "@/lib/wallet-auth";
import { getSolBalance, getSplTokenBalances, getBnbBalance } from "@/lib/balances";
import { fetchTokenPricesUsd } from "@/lib/prices";
import { getTradePresets, saveTradePresets, getActiveQuickBuyAmount, type TradePresets } from "@/lib/trade-presets";
import type { WalletSigner } from "@/lib/agents-engine";
import ExecutionBay from "@/components/ExecutionBay";
import TrenchesView from "@/components/TrenchesView";
import TrackView from "@/components/TrackView";
import CopyView from "@/components/CopyView";
import HolderDistributionView from "@/components/HolderDistributionView";

/* =========================================================================
   TYPES
========================================================================= */

type ThemeName = "cosmic" | "black" | "light";
type TabName = "discover" | "trenches" | "track" | "copy" | "portfolio";
type SettingsView =
  | "main"
  | "trade"
  | "quickbuy"
  | "wallet"
  | "security"
  | "help"
  | "about"
  | "preferences"
  | "executionbay";

const THEME_META: Record<ThemeName, { bg: string; label: string }> = {
  cosmic: { bg: "#05070D", label: "Cosmic Space & Flora" },
  black: { bg: "#000000", label: "Pure Black" },
  light: { bg: "#FFFFFF", label: "Clean Light" },
};

/* =========================================================================
   THEME CONTEXT — drives the data-theme attribute + <meta theme-color>
========================================================================= */

const ThemeContext = createContext<{
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
}>({ theme: "cosmic", setTheme: () => {} });

const useTheme = () => useContext(ThemeContext);

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>("cosmic");

  useEffect(() => {
    const stored = window.localStorage.getItem("ji-theme") as ThemeName | null;
    if (stored && THEME_META[stored]) setThemeState(stored);
  }, []);

  const setTheme = useCallback((t: ThemeName) => {
    setThemeState(t);
    window.localStorage.setItem("ji-theme", t);
  }, []);

  useEffect(() => {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", THEME_META[theme].bg);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/* =========================================================================
   AMBIENT BACKGROUND — bioluminescent flora, cosmic theme only
========================================================================= */

function FloraBackground() {
  const { theme } = useTheme();
  if (theme !== "cosmic") return null;
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      <div
        className="flora-blob animate-drift"
        style={{
          width: 340,
          height: 340,
          left: -80,
          bottom: -100,
          background: "radial-gradient(circle, rgba(34,211,238,0.22), transparent 70%)",
        }}
      />
      <div
        className="flora-blob animate-drift"
        style={{
          width: 300,
          height: 300,
          right: -60,
          top: -60,
          animationDelay: "3s",
          background: "radial-gradient(circle, rgba(124,58,237,0.2), transparent 70%)",
        }}
      />
      <div
        className="flora-blob animate-drift"
        style={{
          width: 220,
          height: 220,
          right: 40,
          bottom: 120,
          animationDelay: "6s",
          background: "radial-gradient(circle, rgba(255,107,0,0.1), transparent 70%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.5) 0, transparent 100%), radial-gradient(1px 1px at 70% 60%, rgba(255,255,255,0.35) 0, transparent 100%), radial-gradient(1px 1px at 40% 80%, rgba(255,255,255,0.3) 0, transparent 100%), radial-gradient(1.5px 1.5px at 85% 20%, rgba(255,255,255,0.4) 0, transparent 100%)",
          backgroundSize: "100% 100%",
          opacity: 0.6,
        }}
      />
    </div>
  );
}

/* =========================================================================
   CROWN LOADER
========================================================================= */

function CrownLoader({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2400);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-[var(--bg)]"
      exit={{ opacity: 0, transition: { duration: 0.5, ease: "easeInOut" } }}
    >
      <div className="relative flex h-36 w-36 items-center justify-center">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(255,136,0,0.35), rgba(255,107,0,0.08) 60%, transparent 75%)",
          }}
          animate={{ opacity: [0.5, 1, 0.5], scale: [0.92, 1.08, 0.92] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 5, repeat: Infinity, ease: "linear" }}
          className="relative h-24 w-24"
        >
          <motion.div
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            className="relative h-full w-full"
          >
            <Image
              src="/logo.png"
              alt="Jobless Intel"
              fill
              sizes="96px"
              className="rounded-full object-contain drop-shadow-[0_0_18px_rgba(255,136,0,0.55)]"
              priority
            />
          </motion.div>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.6 }}
        className="flex flex-col items-center gap-1"
      >
        <span className="shimmer-text animate-shimmer font-display text-2xl font-semibold tracking-tight">
          Jobless Intel
        </span>
        <span className="font-mono text-[11px] tracking-[0.2em] text-[var(--text-dim)]">
          BOOTING TERMINAL…
        </span>
      </motion.div>
    </motion.div>
  );
}

/* =========================================================================
   CHART — faux candlesticks with a faint watermark
========================================================================= */

const CHART_POLL_MS = 30_000;

/** Live OHLCV candles for a token, polling on an interval. Falls back to
 * `null` (not fake data) on error so the UI can show a real empty/error
 * state instead of pretending there's a feed. */
function useLiveCandles(network: ChartNetwork, tokenAddress: string, timeframe: Timeframe = "1h") {
  const [state, setState] = useState<{
    candles: Candle[];
    baseSymbol: string;
    quoteSymbol: string;
    priceUsd: number;
    loading: boolean;
    error: string | null;
  }>({ candles: [], baseSymbol: "", quoteSymbol: "", priceUsd: 0, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval>;

    async function load() {
      try {
        const { pool, candles } = await fetchLiveChart(network, tokenAddress, timeframe);
        if (cancelled) return;
        setState({
          candles,
          baseSymbol: pool.baseSymbol,
          quoteSymbol: pool.quoteSymbol,
          priceUsd: pool.priceUsd,
          loading: false,
          error: null,
        });
      } catch (err: any) {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, error: err.message ?? "Chart feed error" }));
      }
    }

    setState((s) => ({ ...s, loading: true }));
    load();
    timer = setInterval(load, CHART_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [network, tokenAddress, timeframe]);

  return state;
}

function TerminalChart({
  network = "solana",
  tokenAddress,
  timeframe = "1h",
}: {
  network?: ChartNetwork;
  tokenAddress: string;
  timeframe?: Timeframe;
}) {
  const { candles, baseSymbol, quoteSymbol, priceUsd, loading, error } = useLiveCandles(
    network,
    tokenAddress,
    timeframe
  );

  const max = candles.length ? Math.max(...candles.map((c) => c.high)) : 1;
  const min = candles.length ? Math.min(...candles.map((c) => c.low)) : 0;
  const range = max - min || 1;
  const W = 100;
  const H = 100;
  const slot = candles.length ? W / candles.length : W;
  const y = (v: number) => H - ((v - min) / range) * H;

  const first = candles[0]?.open ?? 0;
  const last = candles[candles.length - 1]?.close ?? priceUsd;
  const pctChange = first ? ((last - first) / first) * 100 : 0;

  return (
    <div className="glass-panel relative h-64 w-full overflow-hidden rounded-2xl">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="select-none font-display text-4xl font-bold tracking-widest text-[var(--text)] opacity-[0.08]">
          JOBLESS INTEL
        </span>
      </div>

      {candles.length > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="relative h-full w-full">
          {candles.map((c, i) => {
            const up = c.close >= c.open;
            const cx = i * slot + slot / 2;
            const bodyTop = y(Math.max(c.open, c.close));
            const bodyBottom = y(Math.min(c.open, c.close));
            return (
              <g key={c.time}>
                <line
                  x1={cx}
                  x2={cx}
                  y1={y(c.high)}
                  y2={y(c.low)}
                  stroke={up ? "var(--success)" : "var(--danger)"}
                  strokeWidth={0.25}
                  opacity={0.85}
                />
                <rect
                  x={cx - slot * 0.28}
                  y={bodyTop}
                  width={slot * 0.56}
                  height={Math.max(0.6, bodyBottom - bodyTop)}
                  fill={up ? "var(--success)" : "var(--danger)"}
                  opacity={0.95}
                />
              </g>
            );
          })}
        </svg>
      )}

      {loading && candles.length === 0 && !error && (
        <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-[var(--text-dim)]">
          Loading live chart…
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-xs text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="absolute left-3 top-3 flex flex-col">
        <span className="font-mono text-xs text-[var(--text-dim)]">
          {baseSymbol && quoteSymbol ? `$${baseSymbol} / ${quoteSymbol}` : "resolving pair…"}
        </span>
        <span
          className={`font-mono text-lg font-semibold ${pctChange >= 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}
        >
          ${(last || priceUsd).toFixed(last < 1 ? 6 : 2)}{" "}
          <span className="text-xs opacity-80">
            {pctChange >= 0 ? "+" : ""}
            {pctChange.toFixed(2)}%
          </span>
        </span>
      </div>

      <span className="absolute right-3 top-3 font-mono text-[10px] tracking-widest text-[var(--text-dim)]">
        LIVE · {timeframe.toUpperCase()}
      </span>
    </div>
  );
}

/* =========================================================================
   SHARED UI PRIMITIVES
========================================================================= */

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
        checked ? "bg-accent" : "bg-[var(--bg-elevated-strong)]"
      }`}
      style={checked ? { boxShadow: "0 0 10px rgba(255,107,0,0.55)" } : undefined}
    >
      <motion.span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow"
        animate={{ left: checked ? 22 : 2 }}
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
      />
    </button>
  );
}

function Row({
  label,
  sub,
  icon,
  onClick,
  right,
  danger,
}: {
  label: string;
  sub?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  right?: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-3.5 text-left transition-colors duration-150 hover:border-[var(--border)] hover:bg-[var(--bg-elevated)] active:scale-[0.99]"
    >
      {icon && (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-elevated-strong)] text-sm">
          {icon}
        </span>
      )}
      <span className="flex-1">
        <span
          className={`block text-[15px] ${danger ? "text-[var(--danger)]" : "text-[var(--text)]"}`}
        >
          {label}
        </span>
        {sub && <span className="block text-xs text-[var(--text-dim)]">{sub}</span>}
      </span>
      {right ?? (
        <span className="font-mono text-[var(--text-dim)]">›</span>
      )}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-2 pt-5 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
      {children}
    </div>
  );
}

function ScreenHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-4">
      <button
        onClick={onBack}
        aria-label="Back"
        className="flex h-9 w-9 items-center justify-center rounded-full text-lg text-[var(--text)] transition-colors hover:bg-[var(--bg-elevated)]"
      >
        ←
      </button>
      <span className="font-display text-[15px] font-semibold">{title}</span>
      <span className="flex h-9 w-9 items-center justify-center">{right}</span>
    </div>
  );
}

/* =========================================================================
   SETTINGS — SUB-SCREENS
========================================================================= */

function MainSettingsMenu({
  onNavigate,
  onClose,
}: {
  onNavigate: (v: SettingsView) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-4">
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="flex h-9 w-9 items-center justify-center rounded-full text-lg hover:bg-[var(--bg-elevated)]"
        >
          ←
        </button>
        <span className="font-display text-[15px] font-semibold">Settings</span>
        <button
          aria-label="Scan QR"
          className="flex h-9 w-9 items-center justify-center rounded-full text-base hover:bg-[var(--bg-elevated)]"
        >
          ▢
        </button>
      </div>

      <div className="flex-1 overflow-y-auto thin-scroll px-2 pb-6">
        <Row
          label="Invite Friends 💰"
          sub="Earn commissions"
          icon="🎁"
          onClick={() => {}}
        />
        <div className="my-3 h-px bg-[var(--border)]" />
        <Row label="Trade Settings" icon="⚙" onClick={() => onNavigate("trade")} />
        <Row label="Wallet Manager" icon="◈" onClick={() => onNavigate("wallet")} />
        <Row label="Security" icon="⛊" onClick={() => onNavigate("security")} />
        <Row label="Notification Settings" icon="◔" onClick={() => {}} />
        <Row label="Preferences" icon="◐" onClick={() => onNavigate("preferences")} />
        <div className="my-3 h-px bg-[var(--border)]" />
        <Row label="Help & Support" icon="?" onClick={() => onNavigate("help")} />
        <Row
          label="About Us"
          sub="Version 3.1.11.2"
          icon="ⓘ"
          onClick={() => onNavigate("about")}
        />
      </div>

      <div className="border-t border-[var(--border)] px-4 py-4">
        <div className="mb-4 flex items-center justify-center gap-6">
          <button
            aria-label="X"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-sm hover:bg-[var(--bg-elevated)]"
          >
            𝕏
          </button>
          <button
            aria-label="Telegram"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-sm hover:bg-[var(--bg-elevated)]"
          >
            ✈
          </button>
        </div>
        <button className="w-full rounded-xl border border-[var(--danger)]/40 py-3 text-sm font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10">
          Disconnect
        </button>
      </div>
    </div>
  );
}

function TradeSettingsScreen({ onBack, onNavigate }: { onBack: () => void; onNavigate: (v: SettingsView) => void }) {
  const [secondOrder, setSecondOrder] = useState(true);
  const [floatingBall, setFloatingBall] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Trade Settings" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-2 pb-6">
        <SectionLabel>ORDER ROUTING</SectionLabel>
        <Row label="Trade with USDX" sub="Default quote currency" onClick={() => {}} />
        <Row label="Quick Buy Settings" sub="Preset amounts & slippage" onClick={() => onNavigate("quickbuy")} />
        <Row label="Execution Bay" sub="Limit / TP / SL / trailing / DCA" onClick={() => onNavigate("executionbay")} />
        <Row label="Trade Preference" sub="Native Trading" onClick={() => {}} />
        <Row label="Multi Wallet Trading" sub="Split orders across wallets" onClick={() => {}} />

        <SectionLabel>CONFIRMATIONS</SectionLabel>
        <div className="flex items-center justify-between rounded-xl px-3 py-3.5">
          <div>
            <div className="text-[15px] text-[var(--text)]">Second Order Confirmation</div>
            <div className="text-xs text-[var(--text-dim)]">Confirm before every order fires</div>
          </div>
          <Toggle checked={secondOrder} onChange={setSecondOrder} />
        </div>
        <div className="flex items-center justify-between rounded-xl px-3 py-3.5">
          <div>
            <div className="text-[15px] text-[var(--text)]">Floating Ball</div>
            <div className="text-xs text-[var(--text-dim)]">Quick-trade bubble overlay</div>
          </div>
          <Toggle checked={floatingBall} onChange={setFloatingBall} />
        </div>
      </div>
    </div>
  );
}

function QuickBuySettingsScreen({ onBack }: { onBack: () => void }) {
  const [presets, setPresets] = useState<TradePresets>(getTradePresets);

  function update(patch: Partial<TradePresets>) {
    const next = { ...presets, ...patch };
    setPresets(next);
    saveTradePresets(next);
  }

  function updateAmount(slot: 0 | 1 | 2, value: number) {
    const amounts = [...presets.amounts] as TradePresets["amounts"];
    amounts[slot] = value;
    update({ amounts });
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Quick Buy Settings" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-4 pb-6">
        <SectionLabel>PRESETS (SOL)</SectionLabel>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {([0, 1, 2] as const).map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => update({ activeSlot: slot })}
              className={`rounded-xl border p-3 text-center transition-colors ${
                presets.activeSlot === slot
                  ? "border-[var(--accent)] bg-[var(--accent)]/15"
                  : "border-[var(--border)]"
              }`}
            >
              <div className="font-mono text-[10px] text-[var(--text-dim)]">P{slot + 1}</div>
              <input
                type="number"
                step={0.01}
                min={0}
                value={presets.amounts[slot]}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => updateAmount(slot, Number(e.target.value) || 0)}
                className="w-full bg-transparent text-center font-mono text-sm font-semibold text-[var(--text)]"
              />
            </button>
          ))}
        </div>
        <p className="mb-4 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
          The highlighted preset is what every one-tap Buy button (Trenches, Wallet Tracker) uses.
        </p>

        <SectionLabel>SLIPPAGE</SectionLabel>
        <div className="mb-4 flex items-center gap-2 px-3">
          <input
            type="range"
            min={10}
            max={2000}
            step={10}
            value={presets.slippageBps}
            onChange={(e) => update({ slippageBps: Number(e.target.value) })}
            className="flex-1 accent-[var(--accent)]"
          />
          <span className="w-14 text-right font-mono text-xs">{(presets.slippageBps / 100).toFixed(1)}%</span>
        </div>

        <SectionLabel>ANTI-MEV</SectionLabel>
        <div className="mb-2 grid grid-cols-3 gap-2 px-3">
          {(["off", "reduced", "secure"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => update({ antiMev: m })}
              className={`rounded-lg border px-2 py-2 font-mono text-[11px] capitalize transition-colors ${
                presets.antiMev === m
                  ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-bright)]"
                  : "border-[var(--border)] text-[var(--text-dim)]"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="px-3 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
          "Secure" routes swaps through Jito's private bundle (see the Execution Bay's Jito MEV
          Shield) instead of the public mempool.
        </p>
      </div>
    </div>
  );
}

function ExecutionBayScreen({ onBack, wallet }: { onBack: () => void; wallet: WalletSigner | null }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Execution Bay" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-4 pb-6 pt-2">
        <ExecutionBay wallet={wallet} />
      </div>
    </div>
  );
}

function SyncAcrossDevicesRow() {
  const { status, error, signInWithWallet } = useWalletAuth();
  const { connected } = useWallet();

  const label =
    status === "linked"
      ? "Synced ✓"
      : status === "signing"
        ? "Waiting for wallet signature…"
        : status === "linking"
          ? "Linking…"
          : "Sync Across Devices";

  return (
    <div className="glass-panel mb-3 rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Cloud Sync</div>
          <div className="font-mono text-[10px] text-[var(--text-dim)]">
            Presets, tracked wallets & watchlist, via Supabase
          </div>
        </div>
        <button
          type="button"
          disabled={!connected || status === "signing" || status === "linking" || status === "linked"}
          onClick={signInWithWallet}
          className="lx-btn"
        >
          {label}
        </button>
      </div>
      {!connected && (
        <p className="mt-2 font-mono text-[10px] text-[var(--text-dim)]">Connect a Solana wallet first.</p>
      )}
      {error && (
        <>
          <p className="mt-2 font-mono text-[10px] text-[var(--danger)]">{error}</p>
          <p className="mt-1 font-mono text-[10px] text-[var(--text-dim)]">
            If this wallet was already synced from another browser, that&apos;s a known limitation —
            each browser gets its own identity until account-merge is built.
          </p>
        </>
      )}
    </div>
  );
}

function WalletManagerScreen({ onBack }: { onBack: () => void }) {
  const [archived, setArchived] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        title="Wallet Manager"
        onBack={onBack}
        right={
          <button
            onClick={() => setArchived((a) => !a)}
            className="font-mono text-[10px] tracking-wide text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {archived ? "ACTIVE" : "ARCHIVE"}
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto thin-scroll px-3 py-3">
        <SyncAcrossDevicesRow />
        {!archived ? (
          <div className="glass-panel rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display text-[15px] font-semibold">
                    Wallet 1
                  </span>
                  <span className="rounded-full bg-[var(--bg-elevated-strong)] px-2 py-0.5 font-mono text-[10px] text-glow-cyan">
                    Linked 𝕏
                  </span>
                </div>
                <span className="font-mono text-xs text-[var(--text-dim)]">
                  6m9A…9qn8
                </span>
              </div>
              <span className="font-mono text-sm font-semibold text-[var(--success)]">
                12.84 SOL
              </span>
            </div>
            <div className="mt-3 flex justify-between font-mono text-xs text-[var(--text-dim)]">
              <span>30D Volume</span>
              <span className="text-[var(--text)]">$184,320</span>
            </div>
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center font-mono text-xs text-[var(--text-dim)]">
            No archived wallets
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 border-t border-[var(--border)] px-4 py-4">
        <button className="rounded-xl border border-[var(--border)] py-3 text-sm font-medium hover:bg-[var(--bg-elevated)]">
          Import Private Key
        </button>
        <button className="hairline-glow rounded-xl bg-accent py-3 text-sm font-semibold text-white shadow-[0_0_18px_rgba(255,107,0,0.4)] transition-transform active:scale-[0.98]">
          Create Wallet
        </button>
      </div>
    </div>
  );
}

function SecurityScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Security" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-2 pb-6">
        <SectionLabel>ACCOUNT SECURITY</SectionLabel>
        <Row label="Passkey" sub="Not set up" icon="🔑" onClick={() => {}} />
        <Row
          label="Email Verification"
          icon="✉"
          onClick={() => {}}
          right={<span className="text-[var(--success)]">✓</span>}
        />
        <Row label="Google Authenticator" sub="Not linked" icon="⛨" onClick={() => {}} />

        <SectionLabel>ACCOUNT</SectionLabel>
        <Row label="Logged-in Devices" sub="1 active" icon="▣" onClick={() => {}} />
        <Row label="Change Password" icon="✎" onClick={() => {}} />
      </div>
    </div>
  );
}

function HelpSupportScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Help & Support" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-2 pb-2">
        <SectionLabel>TOPICS</SectionLabel>
        <Row label="Tutorial" icon="▶" onClick={() => {}} />
        <Row label="Featured Icon Definition" icon="◆" onClick={() => {}} />
        <Row label="Reason for Trade Order Failure" icon="⚠" onClick={() => {}} />
        <Row label="Fees & Common Charges" icon="%" onClick={() => {}} />
      </div>
      <div className="grid grid-cols-2 gap-3 border-t border-[var(--border)] px-4 py-4">
        <button className="rounded-xl border border-[var(--border)] py-3 text-sm font-medium hover:bg-[var(--bg-elevated)]">
          Telegram Support
        </button>
        <button className="rounded-xl border border-[var(--border)] py-3 text-sm font-medium hover:bg-[var(--bg-elevated)]">
          Email Support
        </button>
      </div>
    </div>
  );
}

function AboutUsScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="About Us" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-2 pb-6">
        <div className="flex flex-col items-center gap-2 py-6">
          <div className="relative h-14 w-14">
            <Image src="/logo.png" alt="Jobless Intel" fill className="rounded-full object-contain" />
          </div>
          <span className="font-display text-base font-semibold">Jobless Intel</span>
          <span className="font-mono text-xs text-[var(--text-dim)]">Build 3.1.11.2</span>
        </div>
        <Row
          label="Send Diagnostic Report"
          sub="Only includes device model & error logs"
          icon="⛭"
          onClick={() => {}}
        />
        <Row label="Check for Update" icon="↻" onClick={() => {}} />
        <Row label="Privacy Policy" icon="▤" onClick={() => {}} />
        <Row label="Terms of Service" icon="▤" onClick={() => {}} />
        <div className="my-2 h-px bg-[var(--border)]" />
        <Row label="Delete Account" icon="✕" danger onClick={() => {}} />
      </div>
    </div>
  );
}

function PreferencesScreen({ onBack }: { onBack: () => void }) {
  const { theme, setTheme } = useTheme();
  const options: { key: ThemeName; swatch: string }[] = [
    { key: "cosmic", swatch: "linear-gradient(135deg,#05070D,#0e2233,#1b0e33)" },
    { key: "black", swatch: "#000000" },
    { key: "light", swatch: "#FFFFFF" },
  ];
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Preferences" onBack={onBack} />
      <div className="flex-1 overflow-y-auto thin-scroll px-4 pb-6">
        <SectionLabel>BACKGROUND</SectionLabel>
        <div className="flex flex-col gap-3">
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setTheme(opt.key)}
              className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                theme === opt.key
                  ? "border-accent"
                  : "border-[var(--border)] hover:bg-[var(--bg-elevated)]"
              }`}
            >
              <span
                className="h-9 w-9 shrink-0 rounded-lg border border-[var(--border)]"
                style={{ background: opt.swatch }}
              />
              <span className="flex-1 text-[15px]">{THEME_META[opt.key].label}</span>
              {theme === opt.key && (
                <span className="font-mono text-accent">✓</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   SETTINGS DRAWER — stack-based nested navigation
========================================================================= */

function SettingsDrawer({
  stack,
  push,
  pop,
  close,
  wallet,
}: {
  stack: SettingsView[];
  push: (v: SettingsView) => void;
  pop: () => void;
  close: () => void;
  wallet: WalletSigner | null;
}) {
  const active = stack[stack.length - 1];

  return (
    <motion.div
      className="fixed inset-0 z-50 flex justify-end"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="absolute inset-0 bg-black/50"
        onClick={close}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.div
        className="glass-panel relative h-full w-full max-w-sm border-l border-[var(--border)] bg-[var(--bg)]"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 320, damping: 34 }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.22 }}
            className="h-full"
          >
            {active === "main" && (
              <MainSettingsMenu onNavigate={push} onClose={close} />
            )}
            {active === "trade" && <TradeSettingsScreen onBack={pop} onNavigate={push} />}
            {active === "quickbuy" && <QuickBuySettingsScreen onBack={pop} />}
            {active === "executionbay" && <ExecutionBayScreen onBack={pop} wallet={wallet} />}
            {active === "wallet" && <WalletManagerScreen onBack={pop} />}
            {active === "security" && <SecurityScreen onBack={pop} />}
            {active === "help" && <HelpSupportScreen onBack={pop} />}
            {active === "about" && <AboutUsScreen onBack={pop} />}
            {active === "preferences" && <PreferencesScreen onBack={pop} />}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/* =========================================================================
   TOP BAR + BOTTOM NAV
========================================================================= */

function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect: evmDisconnect } = useDisconnect();

  const solLabel = connected && publicKey
    ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}`
    : "SOL";

  const evmLabel = evmConnected && evmAddress
    ? `${evmAddress.slice(0, 4)}…${evmAddress.slice(-4)}`
    : "BSC";

  return (
    <div className="flex items-center justify-between px-4 py-4">
      <div className="flex items-center gap-2">
        <div className="relative h-8 w-8 overflow-hidden rounded-full animate-breathe">
          <Image src="/logo.png" alt="Jobless Intel" fill className="object-contain" />
        </div>
        <span className="font-display text-[15px] font-semibold tracking-tight">
          Jobless Intel
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          id="solanaWalletBtn"
          onClick={() => (connected ? disconnect() : setVisible(true))}
          className="hairline-glow rounded-full px-3 py-2 font-mono text-[11px] font-medium text-[var(--text)] transition-transform active:scale-95"
        >
          ⚡ {solLabel}
        </button>
        <button
          id="bscWalletBtn"
          onClick={() => (evmConnected ? evmDisconnect() : connect({ connector: connectors[0] }))}
          className="rounded-full border border-[var(--border)] px-3 py-2 font-mono text-[11px] font-medium text-[var(--text)] transition-transform active:scale-95 hover:bg-[var(--bg-elevated)]"
        >
          🟡 {evmLabel}
        </button>
        <button
          onClick={onOpenSettings}
          aria-label="Open settings"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] hover:bg-[var(--bg-elevated)]"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

const TABS: { key: TabName; label: string; icon: string }[] = [
  { key: "discover", label: "Discover", icon: "◎" },
  { key: "trenches", label: "Trenches", icon: "⛏" },
  { key: "track", label: "Track", icon: "◈" },
  { key: "copy", label: "Copy", icon: "⇄" },
  { key: "portfolio", label: "Portfolio", icon: "▤" },
];

function BottomNav({
  active,
  onChange,
}: {
  active: TabName;
  onChange: (t: TabName) => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center pb-[calc(env(safe-area-inset-bottom,0px)+14px)]">
      <div className="glass-panel pointer-events-auto flex items-center gap-1 rounded-full px-2 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.35)]">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              className="relative flex flex-col items-center gap-0.5 rounded-full px-3.5 py-2"
            >
              {isActive && (
                <motion.div
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-full bg-accent shadow-[0_0_16px_rgba(255,107,0,0.55)]"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <span
                className={`relative text-sm ${isActive ? "text-white" : "text-[var(--text-dim)]"}`}
              >
                {tab.icon}
              </span>
              <span
                className={`relative font-mono text-[10px] ${isActive ? "text-white" : "text-[var(--text-dim)]"}`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   DISCOVER FEED — the default terminal home
========================================================================= */

function StatChip({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="glass-panel flex flex-col gap-1 rounded-xl px-3 py-2.5">
      <span className="font-mono text-[10px] tracking-wide text-[var(--text-dim)]">{label}</span>
      <span
        className={`font-mono text-sm font-semibold ${
          tone === "up" ? "text-[var(--success)]" : tone === "down" ? "text-[var(--danger)]" : "text-[var(--text)]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function TokenRow({
  name,
  ticker,
  mcap,
  change,
  active,
  onClick,
}: {
  name: string;
  ticker: string;
  mcap: string;
  change: number;
  active?: boolean;
  onClick?: () => void;
}) {
  const up = change >= 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition-colors hover:bg-[var(--bg-elevated)] ${
        active ? "bg-[var(--bg-elevated)]" : ""
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-elevated-strong)] font-mono text-xs">
          {ticker.slice(0, 2)}
        </div>
        <div>
          <div className="text-sm font-medium">{name}</div>
          <div className="font-mono text-xs text-[var(--text-dim)]">${ticker}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-sm">{mcap}</div>
        <div className={`font-mono text-xs ${up ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
          {up ? "+" : ""}
          {change.toFixed(1)}%
        </div>
      </div>
    </button>
  );
}

function formatUsdCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const TRENDING_POLL_MS = 60_000;

function useTrendingFeed() {
  const [tokens, setTokens] = useState<TrendingToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const feed = await fetchTrendingFeed(10);
        if (!cancelled) {
          setTokens(feed);
          setLoading(false);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          setLoading(false);
          setError(err.message ?? "Trending feed error");
        }
      }
    }
    load();
    const timer = setInterval(load, TRENDING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { tokens, loading, error };
}

// Wrapped SOL — used as the default chart pair since it always resolves
// to a deep, liquid pool. The Trending list below is live (GeckoTerminal
// trending_pools, merged across Solana + BSC) — clicking a row re-points
// the chart at that token.
const DEFAULT_CHART_TOKEN = "So11111111111111111111111111111111111111112";
const DEFAULT_CHART_NETWORK: ChartNetwork = "solana";

function DiscoverView() {
  const [selectedToken, setSelectedToken] = useState<{ network: ChartNetwork; address: string }>({
    network: DEFAULT_CHART_NETWORK,
    address: DEFAULT_CHART_TOKEN,
  });
  const { tokens, loading, error } = useTrendingFeed();
  const selectedStats = tokens.find(
    (t) => t.tokenAddress === selectedToken.address && t.network === selectedToken.network
  );

  return (
    <div className="flex flex-col gap-4 px-4 pb-32 pt-2">
      <TerminalChart network={selectedToken.network} tokenAddress={selectedToken.address} />
      <div className="grid grid-cols-3 gap-2">
        <StatChip
          label="24H VOL"
          value={selectedStats ? formatUsdCompact(selectedStats.volume24hUsd) : "—"}
          tone={selectedStats && selectedStats.change24h >= 0 ? "up" : "down"}
        />
        <StatChip label="LIQUIDITY" value={selectedStats ? formatUsdCompact(selectedStats.liquidityUsd) : "—"} />
        <StatChip label="CHANGE 24H" value={selectedStats ? `${selectedStats.change24h.toFixed(1)}%` : "—"} />
      </div>
      {selectedToken.network === "solana" && <HolderDistributionView mint={selectedToken.address} />}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-display text-sm font-semibold">Trending</span>
          <span className="font-mono text-[10px] text-[var(--text-dim)]">
            {loading ? "LOADING" : error ? "ERROR" : "LIVE"}
          </span>
        </div>
        <div className="glass-panel rounded-2xl p-1">
          {error && (
            <div className="px-3 py-4 text-center font-mono text-xs text-[var(--danger)]">{error}</div>
          )}
          {!error &&
            tokens.map((t, i) => (
              <div key={`${t.network}-${t.tokenAddress}`} className="animate-cascade" style={{ animationDelay: `${i * 0.05}s` }}>
                <TokenRow
                  name={t.name}
                  ticker={t.symbol}
                  mcap={formatUsdCompact(t.liquidityUsd)}
                  change={t.change24h}
                  active={selectedToken.address === t.tokenAddress && selectedToken.network === t.network}
                  onClick={() => setSelectedToken({ network: t.network, address: t.tokenAddress })}
                />
                {i < tokens.length - 1 && <div className="mx-3 h-px bg-[var(--border)]" />}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   PORTFOLIO — real holdings + live USD valuation (no fabricated PnL)
========================================================================= */

const WSOL_MINT = "So11111111111111111111111111111111111111112";

interface HoldingRow {
  network: ChartNetwork;
  symbol: string;
  address: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
}

function PortfolioView() {
  const { connection } = useConnection();
  const { publicKey: solKey, connected: solConnected } = useWallet();
  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const evmPublicClient = usePublicClient();

  const [rows, setRows] = useState<HoldingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!solConnected && !evmConnected) {
      setRows([]);
      return;
    }
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      const out: HoldingRow[] = [];
      try {
        if (solConnected && solKey) {
          const [solBalance, splBalances] = await Promise.all([
            getSolBalance(connection, solKey.toBase58()),
            getSplTokenBalances(connection, solKey.toBase58()),
          ]);
          const mints = [WSOL_MINT, ...splBalances.map((t) => t.mint)];
          const prices = await fetchTokenPricesUsd("solana", mints);

          out.push({
            network: "solana",
            symbol: "SOL",
            address: WSOL_MINT,
            amount: solBalance,
            priceUsd: prices[WSOL_MINT.toLowerCase()] ?? 0,
            valueUsd: solBalance * (prices[WSOL_MINT.toLowerCase()] ?? 0),
          });
          for (const t of splBalances) {
            const priceUsd = prices[t.mint.toLowerCase()] ?? 0;
            out.push({
              network: "solana",
              symbol: `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`,
              address: t.mint,
              amount: t.uiAmount,
              priceUsd,
              valueUsd: t.uiAmount * priceUsd,
            });
          }
        }

        if (evmConnected && evmAddress && evmPublicClient) {
          const bnbBalance = await getBnbBalance(evmPublicClient, evmAddress);
          out.push({
            network: "bsc",
            symbol: "BNB",
            address: "native",
            amount: bnbBalance,
            priceUsd: 0, // BSC has no free keyless "price of native token" lookup wired up yet
            valueUsd: 0,
          });
        }

        if (!cancelled) setRows(out.sort((a, b) => b.valueUsd - a.valueUsd));
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? "Failed to load holdings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [solConnected, solKey, evmConnected, evmAddress, connection, evmPublicClient]);

  const totalUsd = rows.reduce((s, r) => s + r.valueUsd, 0);

  if (!solConnected && !evmConnected) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="font-display text-lg font-semibold">Portfolio</span>
        <span className="max-w-xs font-mono text-xs text-[var(--text-dim)]">
          Connect a wallet to see real holdings and live USD value.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-32 pt-2">
      <div className="glass-panel rounded-2xl p-4">
        <span className="font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          TOTAL VALUE {loading ? "· loading…" : ""}
        </span>
        <div className="mt-1 font-mono text-2xl font-semibold">${totalUsd.toFixed(2)}</div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
          Live balances × current price. Profit/loss isn&apos;t shown — that needs your
          actual buy history, which requires a transaction indexer this build doesn&apos;t
          have wired up yet.
        </p>
      </div>

      {error && (
        <div className="glass-panel rounded-2xl p-4 text-center font-mono text-xs text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="glass-panel rounded-2xl p-1">
        {rows.map((r, i) => (
          <div key={`${r.network}-${r.address}`}>
            <div className="flex items-center justify-between rounded-xl px-3 py-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--bg-elevated-strong)] font-mono text-xs">
                  {r.symbol.slice(0, 2)}
                </div>
                <div>
                  <div className="text-sm font-medium">{r.symbol}</div>
                  <div className="font-mono text-xs text-[var(--text-dim)]">
                    {r.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} · {r.network.toUpperCase()}
                  </div>
                </div>
              </div>
              <div className="text-right font-mono text-sm">
                {r.priceUsd > 0 ? `$${r.valueUsd.toFixed(2)}` : "—"}
              </div>
            </div>
            {i < rows.length - 1 && <div className="mx-3 h-px bg-[var(--border)]" />}
          </div>
        ))}
        {!loading && rows.length === 0 && !error && (
          <div className="px-3 py-6 text-center font-mono text-xs text-[var(--text-dim)]">
            No token balances found.
          </div>
        )}
      </div>
    </div>
  );
}

/* =========================================================================
   TRACK / COPY — honest state: these need a transaction indexer
========================================================================= */



/* =========================================================================
   ROOT APP
========================================================================= */

function TerminalApp() {
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabName>("discover");
  const [settingsStack, setSettingsStack] = useState<SettingsView[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const solanaSigner = useAppWalletSigner();
  const evmSigner = useAppEvmWalletSigner();
  // Prefer whichever chain the person actually connected; if both are
  // connected, Solana wins since it's this terminal's primary chain.
  const walletSigner = solanaSigner ?? evmSigner;

  const openSettings = () => setSettingsStack(["main"]);
  const closeSettings = () => setSettingsStack(null);
  const pushSettings = (v: SettingsView) =>
    setSettingsStack((s) => (s ? [...s, v] : [v]));
  const popSettings = () =>
    setSettingsStack((s) => {
      if (!s || s.length <= 1) return null;
      return s.slice(0, -1);
    });

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  }

  // Shared one-tap Buy handler for Trenches + Wallet Tracker — uses the
  // active Quick Buy preset from Settings > Trade Settings > Quick Buy.
  async function handleBuyToken(mint: string) {
    if (!walletSigner) {
      showToast("Connect a wallet first");
      return;
    }
    const amountSol = getActiveQuickBuyAmount();
    showToast(`Buying ${amountSol} SOL of ${mint.slice(0, 6)}…`);
    try {
      const { signature } = await submitAutomatedTradeOrder({
        orderType: "swap",
        chain: "solana",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: mint,
        amount: String(Math.round(amountSol * 1_000_000_000)),
        wallet: walletSigner,
      });
      showToast(signature ? `Bought — ${signature.slice(0, 8)}…` : "Order submitted");
    } catch (err: any) {
      showToast(`Buy failed — ${err.message}`);
    }
  }

  return (
    <div className="relative min-h-dvh w-full bg-[var(--bg)] text-[var(--text)]">
      <FloraBackground />

      <AnimatePresence>
        {loading && <CrownLoader onDone={() => setLoading(false)} />}
      </AnimatePresence>

      {!loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 mx-auto flex min-h-dvh max-w-md flex-col"
        >
          <TopBar onOpenSettings={openSettings} />
          {tab === "discover" && <DiscoverView />}
          {tab === "trenches" && <TrenchesView onBuyToken={handleBuyToken} />}
          {tab === "portfolio" && <PortfolioView />}
          {tab === "track" && <TrackView onBuyToken={handleBuyToken} />}
          {tab === "copy" && <CopyView />}
          <BottomNav active={tab} onChange={setTab} />

          {toast && (
            <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+90px)] z-40 flex justify-center px-6">
              <div className="glass-panel rounded-full px-4 py-2 font-mono text-[11px] text-[var(--text)] shadow-lg">
                {toast}
              </div>
            </div>
          )}
        </motion.div>
      )}

      <AnimatePresence>
        {settingsStack && (
          <SettingsDrawer
            stack={settingsStack}
            push={pushSettings}
            pop={popSettings}
            close={closeSettings}
            wallet={walletSigner}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Page() {
  return (
    <ThemeProvider>
      <TerminalApp />
    </ThemeProvider>
  );
}
