"use client";

/**
 * Automated TP/SL & Trailing Stop Engine — core logic.
 *
 * Honest architecture note, same spirit as app/api/v1/engine/feed/route.ts:
 * this module is a FOREGROUND monitor. It polls prices and fires exits only
 * while a browser tab running this code is open — there is no server-side
 * cron in this project holding funds or keys, on purpose (see the
 * non-custodial note in engine/feed/route.ts). Two things make that
 * survivable in practice instead of fragile:
 *
 *   1. Fixed Take-Profit and Stop-Loss levels are ALSO mirrored as real
 *      on-chain Jupiter Trigger orders (submitAutomatedTradeOrder with
 *      orderType "take-profit" / "stop-loss") the moment a rule is created.
 *      Those are filled by Jupiter's permissionless keeper network
 *      regardless of whether this tab is open — this engine's polling is
 *      belt-and-suspenders for instant local UI feedback (live PnL,
 *      distance-to-trigger), not the only thing standing between the
 *      position and its exit.
 *   2. Trailing Stop-Loss has no fixed trigger price by definition — its
 *      ceiling only exists by recomputing on every tick — so it CANNOT be
 *      pre-filed on-chain the way a fixed TP/SL can. It only protects the
 *      position while this monitor is actually running. The UI must make
 *      that limitation visible rather than imply "set and forget."
 *
 * If you need trailing stops (or TP/SL) to survive the browser being fully
 * closed, the only correct fix is a real always-on executor — a scheduled
 * job (Vercel Cron / a worker) driven by a securely stored automation
 * signer — which is a distinct, much higher-risk custody system and is
 * intentionally out of scope here, exactly like the note in
 * engine/feed/route.ts.
 */

export type TpSlOrderKind = "take-profit" | "stop-loss" | "trailing-stop";
export type TpSlRuleStatus = "active" | "triggered" | "cancelled" | "error";

export interface TpSlRule {
  id: string;
  walletPublicKey: string;
  /** "wallet-adapter" for the connected extension wallet, otherwise a burner id from lib/burner-vault. */
  signerId: string;
  chain: "solana";
  tokenMint: string;
  tokenSymbol: string;
  /** Token amount (UI units, not base units) this rule exits when triggered. */
  tokenAmount: number;
  entryPriceUsd: number;
  kind: TpSlOrderKind;
  /** Take-profit / stop-loss: signed % move from entry, e.g. +100 or -25. */
  targetPct: number | null;
  /** Trailing stop only: trail width as a % below the running peak, e.g. 10. */
  trailPercent: number | null;
  /** Trailing stop only: highest USD price observed since the rule was created. */
  highWaterMarkUsd: number | null;
  status: TpSlRuleStatus;
  createdAt: number;
  triggeredAt: number | null;
  triggerSignature: string | null;
  lastError: string | null;
}

export interface TrackedPositionRules {
  walletPublicKey: string;
  tokenMint: string;
  tokenSymbol: string;
  rules: TpSlRule[];
}

/** Snapshot of one rule's live state, recomputed every tick. Pure function of (rule, priceUsd). */
export interface TpSlTickState {
  ruleId: string;
  priceUsd: number;
  pnlPct: number;
  /** For take-profit/stop-loss: % move still needed to reach targetPct. For trailing: % above the current stop floor. */
  distancePct: number;
  /** Trailing stop only — the live stop price given the current high-water mark. */
  currentStopPriceUsd: number | null;
  isTriggered: boolean;
}

const POLL_INTERVAL_MS = 4_000;
const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens";

/* ------------------------------------------------------------------ */
/* Price feed — Jupiter primary, DexScreener fallback                 */
/* ------------------------------------------------------------------ */

/** Batched price lookup. Jupiter first (fast, keyless); any mint it misses
 * falls back to DexScreener one-at-a-time (Jupiter doesn't index every
 * freshly-launched mint immediately). Returns USD price per mint. */
export async function fetchLivePricesUsd(mints: string[]): Promise<Record<string, number>> {
  const unique = Array.from(new Set(mints)).filter(Boolean);
  if (unique.length === 0) return {};

  const prices: Record<string, number> = {};

  try {
    const url = `${JUP_PRICE_URL}?ids=${unique.join(",")}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      for (const mint of unique) {
        const p = data?.[mint]?.usdPrice;
        if (typeof p === "number" && p > 0) prices[mint] = p;
      }
    }
  } catch {
    /* fall through to DexScreener for everything below */
  }

  const missing = unique.filter((m) => prices[m] == null);
  for (const mint of missing) {
    try {
      const res = await fetch(`${DEXSCREENER_TOKEN_URL}/${mint}`, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = data?.pairs as any[] | undefined;
      if (!pairs || pairs.length === 0) continue;
      // Most-liquid pair wins when a mint trades across several pools.
      const best = pairs.reduce((a, b) => (Number(b.liquidity?.usd ?? 0) > Number(a.liquidity?.usd ?? 0) ? b : a));
      const p = Number(best.priceUsd);
      if (p > 0) prices[mint] = p;
    } catch {
      /* leave this mint missing for this tick; try again next poll */
    }
  }

  return prices;
}

/* ------------------------------------------------------------------ */
/* Trigger math — pure, testable, no I/O                              */
/* ------------------------------------------------------------------ */

export function pctChange(fromUsd: number, toUsd: number): number {
  if (fromUsd <= 0) return 0;
  return ((toUsd - fromUsd) / fromUsd) * 100;
}

/** Given a rule and a fresh price, decide whether it fires and what the UI
 * should show. Never mutates the rule — callers apply the returned
 * highWaterMarkUsd themselves so this stays a pure function. */
export function evaluateRule(rule: TpSlRule, priceUsd: number): TpSlTickState & { nextHighWaterMarkUsd: number | null } {
  const pnlPct = pctChange(rule.entryPriceUsd, priceUsd);

  if (rule.kind === "take-profit") {
    const target = rule.targetPct ?? 0;
    return {
      ruleId: rule.id,
      priceUsd,
      pnlPct,
      distancePct: Math.max(0, target - pnlPct),
      currentStopPriceUsd: null,
      isTriggered: pnlPct >= target,
      nextHighWaterMarkUsd: null,
    };
  }

  if (rule.kind === "stop-loss") {
    const target = rule.targetPct ?? 0; // negative, e.g. -25
    return {
      ruleId: rule.id,
      priceUsd,
      pnlPct,
      distancePct: Math.max(0, pnlPct - target),
      currentStopPriceUsd: null,
      isTriggered: pnlPct <= target,
      nextHighWaterMarkUsd: null,
    };
  }

  // trailing-stop: ceiling only ever moves up, stop price recomputed off it every tick.
  const trail = rule.trailPercent ?? 0;
  const prevHwm = rule.highWaterMarkUsd ?? rule.entryPriceUsd;
  const nextHwm = Math.max(prevHwm, priceUsd);
  const stopPriceUsd = nextHwm * (1 - trail / 100);
  const distancePct = Math.max(0, pctChange(stopPriceUsd, priceUsd));

  return {
    ruleId: rule.id,
    priceUsd,
    pnlPct,
    distancePct,
    currentStopPriceUsd: stopPriceUsd,
    isTriggered: priceUsd <= stopPriceUsd,
    nextHighWaterMarkUsd: nextHwm,
  };
}

/* ------------------------------------------------------------------ */
/* Exit execution — decoupled from signing, mirrors WalletSigner       */
/* ------------------------------------------------------------------ */

/** Caller supplies this — it resolves a signer (wallet-adapter or a
 * lib/burner-vault keypair) for `rule.signerId` and actually executes the
 * exit swap. The engine itself never touches a private key. Returns the
 * on-chain signature (or null if the route only returned a quote, e.g.
 * fee account not yet configured — see execute-swap-order's `warning`). */
export type ExitExecutor = (rule: TpSlRule, priceUsd: number) => Promise<string | null>;

export type TpSlEngineListener = (states: Record<string, TpSlTickState>) => void;

/**
 * Module-level polling daemon (singleton, not React state) — same pattern
 * as hooks/useBatchTrading.ts's external store: a batch/monitor that's
 * mid-flight should keep reporting even if the panel that opened it
 * unmounts, and a remount should see live state immediately rather than a
 * blank slate.
 */
class PositionMonitorStore {
  private rules: Map<string, TpSlRule> = new Map();
  private states: Record<string, TpSlTickState> = {};
  private listeners = new Set<TpSlEngineListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private executor: ExitExecutor | null = null;
  private polling = false;

  setExecutor(executor: ExitExecutor | null) {
    this.executor = executor;
  }

  setRules(rules: TpSlRule[]) {
    this.rules = new Map(rules.filter((r) => r.status === "active").map((r) => [r.id, r]));
    this.ensureRunning();
  }

  upsertRule(rule: TpSlRule) {
    if (rule.status === "active") {
      this.rules.set(rule.id, rule);
    } else {
      this.rules.delete(rule.id);
      delete this.states[rule.id];
    }
    this.ensureRunning();
    this.notify();
  }

  removeRule(id: string) {
    this.rules.delete(id);
    delete this.states[id];
    this.notify();
  }

  subscribe(listener: TpSlEngineListener): () => void {
    this.listeners.add(listener);
    listener(this.states);
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return this.states;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ensureRunning() {
    if (this.timer || this.rules.size === 0) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick(); // don't wait a full interval for the first read
  }

  private notify() {
    for (const listener of this.listeners) listener(this.states);
  }

  private async tick() {
    if (this.polling || this.rules.size === 0) return;
    this.polling = true;
    try {
      const active = Array.from(this.rules.values());
      const mints = active.map((r) => r.tokenMint);
      const prices = await fetchLivePricesUsd(mints);

      for (const rule of active) {
        const price = prices[rule.tokenMint];
        if (price == null) continue; // couldn't price it this tick — leave last known state, try again next poll

        const result = evaluateRule(rule, price);
        this.states = { ...this.states, [rule.id]: result };

        // Trailing stop's ceiling only ever ratchets upward — persist it
        // even on a tick that doesn't trigger, so a refresh doesn't reset
        // the high-water mark back to entry.
        if (rule.kind === "trailing-stop" && result.nextHighWaterMarkUsd != null && result.nextHighWaterMarkUsd !== rule.highWaterMarkUsd) {
          rule.highWaterMarkUsd = result.nextHighWaterMarkUsd;
          this.rules.set(rule.id, rule);
        }

        if (result.isTriggered && this.executor) {
          // Remove immediately so a slow/failed exit can't be double-fired
          // on the next tick while it's still in flight.
          this.rules.delete(rule.id);
          this.executeExit(rule, price);
        }
      }
      this.notify();
    } finally {
      this.polling = false;
      if (this.rules.size === 0) this.stop();
    }
  }

  private async executeExit(rule: TpSlRule, priceUsd: number) {
    if (!this.executor) return;
    try {
      const signature = await this.executor(rule, priceUsd);
      rule.status = "triggered";
      rule.triggeredAt = Date.now();
      rule.triggerSignature = signature;
    } catch (err: any) {
      rule.status = "error";
      rule.lastError = err?.message ?? "Exit execution failed";
    } finally {
      this.states = {
        ...this.states,
        [rule.id]: {
          ...(this.states[rule.id] ?? evaluateRule(rule, priceUsd)),
          isTriggered: true,
        },
      };
      this.notify();
    }
  }
}

export const positionMonitor = new PositionMonitorStore();
