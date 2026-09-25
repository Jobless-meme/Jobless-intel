"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import type { LogFn } from "@/lib/agents-engine";
import { createBurner, getBurnerKeypair, listBurners, removeBurner, type BurnerInfo } from "@/lib/burner-vault";
import { getTradePresets } from "@/lib/trade-presets";
import {
  DEFAULT_TIMING,
  MAX_BATCH_WALLETS,
  allocateBuy,
  applyEmergencyOverrides,
  errMessage,
  executeBatch,
  fetchSolBalances,
  humanizeError,
  initialLegStates,
  lamportsToSol,
  prepareBatch,
  validateMint,
  type AllocationSpec,
  type BatchPlan,
  type BatchSettings,
  type BatchSide,
  type LegState,
  type PriorityTier,
  type TimingOptions,
} from "@/lib/batch-trading";

/**
 * Batch trading store + hook.
 *
 * The store is a tiny module-level external store (useSyncExternalStore), not
 * component state, on purpose: a batch that's mid-flight keeps running and
 * keeps reporting if the user closes the sheet, and re-opening it shows the
 * live progress. It also means no new dependency (no zustand).
 *
 * What is NOT in here: secret keys. Wallet views carry public info only; keys
 * are resolved from lib/burner-vault at the instant a leg signs.
 */

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type AllocationMode = "equal" | "fixed" | "custom";
export type BatchPhase = "idle" | "preparing" | "review" | "running" | "done";

export interface BatchWalletView extends BurnerInfo {
  /** null until the first balance read lands. */
  balanceSol: number | null;
}

/** Persisted across sessions (per-browser). Amounts are strings so half-typed
 * input like "0." survives a controlled <input>. */
export interface BatchConfig {
  selectedIds: string[];
  allocationMode: AllocationMode;
  totalSol: string;
  perWalletSol: string;
  customSol: Record<string, string>;
  /** Sell size, % of each wallet's balance. */
  sellPercent: number;
  /** null = follow the Quick Buy slippage preset. */
  slippageOverrideBps: number | null;
  priorityTier: PriorityTier;
  maxPriceImpactPct: number;
  timing: TimingOptions;
}

interface BatchRunState {
  phase: BatchPhase;
  side: BatchSide | null;
  plan: BatchPlan | null;
  legs: LegState[];
  aborting: boolean;
  error: string | null;
  /** walletIds currently being individually retried after the batch finished. */
  retryingIds: string[];
}

interface BatchState extends BatchConfig, BatchRunState {
  hydrated: boolean;
  wallets: BatchWalletView[];
  mint: string;
  presetSlippageBps: number;
}

/** A reviewed plan older than this is refused — balances and prices move. */
export const PLAN_MAX_AGE_MS = 90_000;

const CONFIG_KEY = "lx_batch_config_v1";
const BATCH_PRIORITY_TIERS: PriorityTier[] = ["standard", "fast", "turbo"];

const DEFAULT_CONFIG: BatchConfig = {
  selectedIds: [],
  allocationMode: "equal",
  totalSol: "0.5",
  perWalletSol: "0.1",
  customSol: {},
  sellPercent: 100,
  slippageOverrideBps: null,
  priorityTier: "fast",
  maxPriceImpactPct: 15,
  timing: DEFAULT_TIMING,
};

const IDLE_RUN: BatchRunState = {
  phase: "idle",
  side: null,
  plan: null,
  legs: [],
  aborting: false,
  error: null,
  retryingIds: [],
};

const INITIAL_STATE: BatchState = {
  ...DEFAULT_CONFIG,
  ...IDLE_RUN,
  hydrated: false,
  wallets: [],
  mint: "",
  presetSlippageBps: 100,
};

/* ------------------------------------------------------------------ */
/* Store internals                                                    */
/* ------------------------------------------------------------------ */

let state: BatchState = INITIAL_STATE;
const listeners = new Set<() => void>();
let activeAbort: AbortController | null = null;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL_STATE;

function patch(p: Partial<BatchState>, persist = false) {
  state = { ...state, ...p };
  if (persist) persistConfig();
  listeners.forEach((l) => l());
}

function persistConfig() {
  if (typeof window === "undefined") return;
  const cfg: BatchConfig = {
    selectedIds: state.selectedIds,
    allocationMode: state.allocationMode,
    totalSol: state.totalSol,
    perWalletSol: state.perWalletSol,
    customSol: state.customSol,
    sellPercent: state.sellPercent,
    slippageOverrideBps: state.slippageOverrideBps,
    priorityTier: state.priorityTier,
    maxPriceImpactPct: state.maxPriceImpactPct,
    timing: state.timing,
  };
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* storage full / blocked — config just won't persist */
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function loadConfig(): Partial<BatchConfig> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CONFIG_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return {};
    const out: Partial<BatchConfig> = {};

    if (Array.isArray(raw.selectedIds)) out.selectedIds = raw.selectedIds.filter((x: unknown) => typeof x === "string");
    if (["equal", "fixed", "custom"].includes(raw.allocationMode)) out.allocationMode = raw.allocationMode;
    if (typeof raw.totalSol === "string") out.totalSol = raw.totalSol;
    if (typeof raw.perWalletSol === "string") out.perWalletSol = raw.perWalletSol;
    if (raw.customSol && typeof raw.customSol === "object") {
      out.customSol = Object.fromEntries(
        Object.entries(raw.customSol as Record<string, unknown>).filter(([, v]) => typeof v === "string")
      ) as Record<string, string>;
    }
    if (isNum(raw.sellPercent)) out.sellPercent = Math.min(Math.max(raw.sellPercent, 1), 100);
    if (raw.slippageOverrideBps === null || isNum(raw.slippageOverrideBps)) out.slippageOverrideBps = raw.slippageOverrideBps;
    if (BATCH_PRIORITY_TIERS.includes(raw.priorityTier)) out.priorityTier = raw.priorityTier;
    if (isNum(raw.maxPriceImpactPct)) out.maxPriceImpactPct = raw.maxPriceImpactPct;
    if (raw.timing && typeof raw.timing === "object") {
      const t = raw.timing;
      out.timing = {
        mode: ["simultaneous", "stagger", "jitter"].includes(t.mode) ? t.mode : DEFAULT_TIMING.mode,
        staggerMs: isNum(t.staggerMs) ? t.staggerMs : DEFAULT_TIMING.staggerMs,
        jitterMs: isNum(t.jitterMs) ? t.jitterMs : DEFAULT_TIMING.jitterMs,
        amountJitterPct: isNum(t.amountJitterPct) ? t.amountJitterPct : DEFAULT_TIMING.amountJitterPct,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Re-reads the wallet list from the vault, keeping known balances. */
function syncWallets() {
  const prev = new Map(state.wallets.map((w) => [w.id, w.balanceSol]));
  const wallets: BatchWalletView[] = listBurners().map((b) => ({ ...b, balanceSol: prev.get(b.id) ?? null }));
  const ids = new Set(wallets.map((w) => w.id));
  const selectedIds = state.selectedIds.filter((id) => ids.has(id));
  patch({ wallets, selectedIds }, selectedIds.length !== state.selectedIds.length);
}

function ensureHydrated() {
  if (typeof window === "undefined") return;
  if (!state.hydrated) {
    const cfg = { ...DEFAULT_CONFIG, ...loadConfig() };
    patch({ ...cfg, hydrated: true });
  }
  syncWallets();
  // Quick Buy presets can change in Settings between visits — always re-read.
  patch({ presetSlippageBps: getTradePresets().slippageBps });
}

async function refreshBalances(connection: Connection) {
  const addresses = state.wallets.map((w) => w.publicKey);
  if (addresses.length === 0) return;
  try {
    const lamports = await fetchSolBalances(connection, addresses);
    patch({
      wallets: state.wallets.map((w) =>
        lamports[w.publicKey] != null ? { ...w, balanceSol: lamportsToSol(lamports[w.publicKey]) } : w
      ),
    });
  } catch {
    /* transient RPC hiccup — keep showing the last known balances */
  }
}

/* ------------------------------------------------------------------ */
/* Config → engine inputs                                             */
/* ------------------------------------------------------------------ */

function parseSol(v: string | undefined): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildAllocation(s: BatchState): AllocationSpec {
  if (s.allocationMode === "equal") return { kind: "equal", totalSol: parseSol(s.totalSol) };
  if (s.allocationMode === "fixed") return { kind: "fixed", perWalletSol: parseSol(s.perWalletSol) };
  const solByWallet: Record<string, number> = {};
  for (const id of s.selectedIds) solByWallet[id] = parseSol(s.customSol[id]);
  return { kind: "custom", solByWallet };
}

function buildSettings(s: BatchState, emergency: boolean): BatchSettings {
  const base: BatchSettings = {
    slippageBps: s.slippageOverrideBps ?? s.presetSlippageBps,
    priorityTier: s.priorityTier,
    maxPriceImpactPct: s.maxPriceImpactPct,
    timing: s.timing,
  };
  return emergency ? applyEmergencyOverrides(base) : base;
}

/* ------------------------------------------------------------------ */
/* Hook                                                               */
/* ------------------------------------------------------------------ */

export function useBatchTrading(opts: { enabled?: boolean; onLog?: LogFn } = {}) {
  const { enabled = true, onLog } = opts;
  const { connection } = useConnection();
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  // Hydrate + keep balances fresh while the sheet is open (or a batch is live).
  useEffect(() => {
    if (!enabled) return;
    ensureHydrated();
    void refreshBalances(connection);
    const t = setInterval(() => void refreshBalances(connection), 15_000);
    return () => clearInterval(t);
  }, [enabled, connection]);

  const actions = useMemo(() => {
    const setConfig = (p: Partial<BatchConfig>) => patch(p, true);

    return {
      setConfig,
      setMint: (mint: string) => patch({ mint: mint.trim() }),
      setCustomSol: (walletId: string, value: string) =>
        setConfig({ customSol: { ...state.customSol, [walletId]: value } }),
      setTiming: (t: Partial<TimingOptions>) => setConfig({ timing: { ...state.timing, ...t } }),

      /* ---- wallet selection / management ---- */
      toggleWallet: (id: string) => {
        const has = state.selectedIds.includes(id);
        setConfig({ selectedIds: has ? state.selectedIds.filter((x) => x !== id) : [...state.selectedIds, id] });
      },
      selectAll: () => setConfig({ selectedIds: state.wallets.slice(0, MAX_BATCH_WALLETS).map((w) => w.id) }),
      clearSelection: () => setConfig({ selectedIds: [] }),
      createWallet: () => {
        try {
          const b = createBurner();
          syncWallets();
          setConfig({ selectedIds: [...state.selectedIds, b.id] });
          void refreshBalances(connection);
        } catch (err) {
          patch({ error: errMessage(err) });
        }
      },
      deleteWallet: (id: string) => {
        try {
          removeBurner(id);
          syncWallets();
        } catch (err) {
          patch({ error: errMessage(err) });
        }
      },
      refreshBalances: () => refreshBalances(connection),
      dismissError: () => patch({ error: null }),

      /* ---- run lifecycle ---- */

      /** Step 1: read balances, fetch quotes in parallel, gate every wallet. Sends nothing. */
      prepare: async (side: BatchSide, options: { emergency?: boolean } = {}) => {
        if (state.phase !== "idle") return;
        const emergency = !!options.emergency;

        // Emergency Sell All falls back to every wallet when none are ticked —
        // in an emergency, "nothing selected" shouldn't mean "nothing happens".
        const pool =
          emergency && state.selectedIds.length === 0
            ? state.wallets
            : state.wallets.filter((w) => state.selectedIds.includes(w.id));

        patch({ phase: "preparing", side, plan: null, legs: [], error: null, aborting: false });
        try {
          const plan = await prepareBatch(connection, {
            side,
            mint: state.mint,
            wallets: pool.map(({ id, label, publicKey }) => ({ id, label, publicKey })),
            allocation: buildAllocation(state),
            sellPercent: emergency ? 100 : state.sellPercent,
            settings: buildSettings(state, emergency),
            emergency,
            log: onLogRef.current,
          });
          patch({ phase: "review", plan });
        } catch (err) {
          patch({ phase: "idle", side: null, error: humanizeError(err) });
        }
      },

      /** Step 2: sign locally + broadcast every cleared leg. */
      fire: async () => {
        const plan = state.plan;
        if (state.phase !== "review" || !plan) return; // also blocks double-taps

        if (Date.now() - plan.createdAt > PLAN_MAX_AGE_MS) {
          patch({
            phase: "idle",
            plan: null,
            side: null,
            error: "That review expired — prices and balances may have moved. Tap again for a fresh one.",
          });
          return;
        }

        const ctrl = new AbortController();
        activeAbort = ctrl;
        patch({ phase: "running", legs: initialLegStates(plan), aborting: false, error: null });

        try {
          await executeBatch(connection, plan, {
            resolveKeypair: getBurnerKeypair,
            onLeg: (leg) => patch({ legs: state.legs.map((l) => (l.walletId === leg.walletId ? leg : l)) }),
            signal: ctrl.signal,
            log: onLogRef.current,
          });
        } catch (err) {
          patch({ error: humanizeError(err) });
        } finally {
          activeAbort = null;
          patch({ phase: "done", aborting: false });
          void refreshBalances(connection);
        }
      },

      /** Stops legs that haven't broadcast yet. Anything already sent can't be recalled. */
      abort: () => {
        if (state.phase !== "running") return;
        patch({ aborting: true });
        activeAbort?.abort();
      },

      /**
       * Re-runs a single failed leg without touching the rest of the batch.
       * Only valid once the batch has finished ("done") and only for a leg
       * that actually failed — skipped legs failed pre-flight for a reason
       * that won't have changed (no balance, no route) and want a fresh
       * `prepare` instead. Builds a fresh one-wallet plan (fresh balance,
       * fresh quote — never replays a stale one) and reuses the original
       * plan's side/mint/settings/size for that wallet.
       */
      retryLeg: async (walletId: string) => {
        if (state.phase !== "done" || !state.plan) return;
        if (state.retryingIds.includes(walletId)) return;

        const plan = state.plan;
        const leg = state.legs.find((l) => l.walletId === walletId);
        const wallet = state.wallets.find((w) => w.id === walletId);
        if (!leg || !wallet || leg.status !== "failed") return;

        const setLeg = (p: Partial<LegState>) =>
          patch({ legs: state.legs.map((l) => (l.walletId === walletId ? { ...l, ...p } : l)) });

        patch({ retryingIds: [...state.retryingIds, walletId] });
        setLeg({ status: "queued", stage: "Retrying", error: undefined, signature: undefined });

        try {
          const allocation: AllocationSpec =
            plan.side === "buy"
              ? { kind: "custom", solByWallet: { [walletId]: lamportsToSol(Number(leg.inAmount)) } }
              : { kind: "equal", totalSol: 0 }; // sells ignore allocation — sellPercent drives the amount

          const retryPlan = await prepareBatch(connection, {
            side: plan.side,
            mint: plan.mint,
            wallets: [{ id: wallet.id, label: wallet.label, publicKey: wallet.publicKey }],
            allocation,
            sellPercent: plan.sellPercent ?? 100,
            settings: plan.settings,
            emergency: plan.emergency,
            log: onLogRef.current,
          });

          const retryLegPlan = retryPlan.legs[0];
          if (!retryLegPlan || retryLegPlan.preflight !== "ok") {
            setLeg({ status: "failed", stage: undefined, error: retryLegPlan?.issue ?? "Retry pre-flight failed" });
            return;
          }

          await executeBatch(connection, retryPlan, {
            resolveKeypair: getBurnerKeypair,
            onLeg: (l) => patch({ legs: state.legs.map((x) => (x.walletId === walletId ? l : x)) }),
            log: onLogRef.current,
          });
        } catch (err) {
          setLeg({ status: "failed", stage: undefined, error: humanizeError(err) });
        } finally {
          patch({ retryingIds: state.retryingIds.filter((id) => id !== walletId) });
          void refreshBalances(connection);
        }
      },

      cancelReview: () => {
        if (state.phase === "review") patch({ phase: "idle", plan: null, side: null });
      },

      /** Back to the control deck after a finished batch. */
      reset: () => {
        if (state.phase === "done") patch({ ...IDLE_RUN });
      },
    };
  }, [connection]);

  /* ---- derived ---- */
  const selectedWallets = useMemo(
    () => s.wallets.filter((w) => s.selectedIds.includes(w.id)),
    [s.wallets, s.selectedIds]
  );

  const effectiveSlippageBps = s.slippageOverrideBps ?? s.presetSlippageBps;

  const mintError = useMemo(() => {
    if (!s.mint) return null;
    try {
      validateMint(s.mint);
      return null;
    } catch (err) {
      return errMessage(err);
    }
  }, [s.mint]);
  const mintValid = s.mint.length > 0 && mintError === null;

  /** Pre-flight-free preview of the SOL a buy would deploy (amount jitter ignored). */
  const deployPreviewSol = useMemo(() => {
    if (selectedWallets.length === 0) return 0;
    const lamports = allocateBuy(buildAllocation(s), selectedWallets.map((w) => w.id), 0);
    return lamportsToSol(Object.values(lamports).reduce((a, b) => a + b, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWallets, s.allocationMode, s.totalSol, s.perWalletSol, s.customSol]);

  const idle = s.phase === "idle";

  return {
    ...s,
    selectedWallets,
    effectiveSlippageBps,
    mintValid,
    mintError,
    deployPreviewSol,
    canBuy: idle && mintValid && selectedWallets.length > 0 && deployPreviewSol > 0,
    canSell: idle && mintValid && selectedWallets.length > 0,
    canEmergency: idle && mintValid && s.wallets.length > 0,
    actions,
  };
}
