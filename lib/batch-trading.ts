"use client";

import { Connection, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";
import type { LogFn } from "./agents-engine";

/**
 * Multi-Wallet Batch Execution Engine
 * ------------------------------------------------------------------
 * Fans one buy/sell out across several local session (burner) wallets.
 *
 * Zero-custody contract (same as lib/copy-trading.ts):
 *   - Secret keys never leave this browser. The engine route only ever
 *     receives PUBLIC keys and returns UNSIGNED transactions.
 *   - Each leg is signed locally with its own Keypair, then broadcast
 *     straight to the Solana RPC from the client.
 *   - Keypairs are resolved lazily via `resolveKeypair` at the moment a leg
 *     fires, and are never stored on the plan or in any state object.
 *
 * Flow:
 *   prepareBatch()  → balances + parallel Jupiter quotes + safety gates
 *                     (nothing is signed or sent; returns a reviewable plan)
 *   executeBatch()  → per-leg build → sign → send → confirm, all legs in
 *                     parallel, each after its own staggered/jittered delay
 *
 * Quotes are advisory (price-impact guard + expected-out preview). Each leg's
 * swap transaction is built from a FRESH server-side quote at fire time, so
 * staggered legs never execute against a stale price, and the 50bps platform
 * fee can't be bypassed by a client-supplied quote.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const MAX_BATCH_WALLETS = 10;

const ENGINE_URL = "/api/v1/engine/feed";

/* ------------------------------------------------------------------ */
/* Tunables                                                           */
/* ------------------------------------------------------------------ */

export type BatchSide = "buy" | "sell";
export type PriorityTier = "standard" | "fast" | "turbo";

/** Fixed total priority fee per transaction, in lamports. */
export const PRIORITY_TIER_LAMPORTS: Record<PriorityTier, number> = {
  standard: 100_000, // 0.0001 SOL
  fast: 500_000, // 0.0005 SOL
  turbo: 2_000_000, // 0.002 SOL
};

/** SOL a buying wallet must keep beyond its allocation: tx fee + rent for a
 * new token account + rent-exempt floor for the wallet itself. */
export const BASE_FEE_RESERVE_LAMPORTS = 3_500_000; // 0.0035 SOL
/** SOL a selling wallet needs on hand (tx fee + temporary wSOL account rent). */
export const SELL_FEE_RESERVE_LAMPORTS = 2_500_000; // 0.0025 SOL

export const MAX_STAGGER_MS = 5_000;
export const MAX_JITTER_MS = 3_000;
const MAX_TOTAL_DELAY_MS = 30_000;

export const MIN_SLIPPAGE_BPS = 10; // 0.1%
export const MAX_SLIPPAGE_BPS = 5_000; // 50%

export const EMERGENCY_MIN_SLIPPAGE_BPS = 1_500; // 15%
export const EMERGENCY_MAX_IMPACT_PCT = 50;

export type TimingMode = "simultaneous" | "stagger" | "jitter";

export interface TimingOptions {
  /** simultaneous: all legs at once. stagger: evenly spaced in random wallet order.
   * jitter: spaced AND randomised, so no two runs share a rhythm. */
  mode: TimingMode;
  staggerMs: number;
  jitterMs: number;
  /** ±% randomisation of per-wallet size in Equal Split mode (total is preserved). */
  amountJitterPct: number;
}

export const DEFAULT_TIMING: TimingOptions = {
  mode: "simultaneous",
  staggerMs: 800,
  jitterMs: 600,
  amountJitterPct: 0,
};

export interface BatchSettings {
  slippageBps: number;
  priorityTier: PriorityTier;
  /** Legs whose quoted price impact exceeds this are skipped, not executed. */
  maxPriceImpactPct: number;
  timing: TimingOptions;
}

export type AllocationSpec =
  | { kind: "equal"; totalSol: number }
  | { kind: "fixed"; perWalletSol: number }
  | { kind: "custom"; solByWallet: Record<string, number> };

/* ------------------------------------------------------------------ */
/* Errors + small utilities                                           */
/* ------------------------------------------------------------------ */

export type BatchErrorCode = "invalid_input" | "aborted" | "engine" | "rpc" | "no_tx";

export class BatchError extends Error {
  code: BatchErrorCode;
  constructor(code: BatchErrorCode, message: string) {
    super(message);
    this.name = "BatchError";
    this.code = code;
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const abortError = () => new BatchError("aborted", "Cancelled");
const isAbort = (err: unknown) => err instanceof BatchError && err.code === "aborted";

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Number.isFinite(n) ? n : lo, lo), hi);

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function solToLamports(sol: number): number {
  if (!Number.isFinite(sol) || sol <= 0) return 0;
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export const lamportsToSol = (lamports: number) => lamports / LAMPORTS_PER_SOL;

const fmtSol = (lamports: number) => lamportsToSol(lamports).toFixed(4);

export function shortAddress(addr: string, head = 4, tail = 4): string {
  return addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export const explorerTxUrl = (signature: string) => `https://solscan.io/tx/${signature}`;

/** Base-unit string → human string ("1234500000", 6 → "1,234.5"). */
export function formatUnits(raw: string | bigint, decimals: number, maxFrac = 4): string {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return "—";
  }
  const base = BigInt(10) ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  if (whole === BigInt(0) && frac > BigInt(0) && !fracStr) return `<0.${"0".repeat(Math.max(maxFrac - 1, 0))}1`;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Turns raw RPC / program errors into something a trader can act on. */
export function humanizeError(err: unknown): string {
  if (err instanceof BatchError) return err.message;
  const raw = errMessage(err);
  const m = raw.toLowerCase();
  if (m.includes("0x1771") || m.includes("slippage")) {
    return "Slippage exceeded — price moved past your limit. Raise slippage or retry.";
  }
  if (
    m.includes("insufficient lamports") ||
    m.includes("insufficient funds") ||
    m.includes("found no record of a prior credit")
  ) {
    return "Not enough SOL to cover the swap plus fees/rent.";
  }
  if ((err instanceof Error && err.name.includes("Expired")) || m.includes("blockhash not found")) {
    return "Transaction expired before landing on-chain. Nothing was executed — safe to retry.";
  }
  if (m.includes("429") || m.includes("too many requests")) {
    return "RPC rate-limited. Set a dedicated NEXT_PUBLIC_SOLANA_RPC_URL or use a wider stagger.";
  }
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
}

/* ------------------------------------------------------------------ */
/* Engine client (our own /api/v1/engine/feed route)                  */
/* ------------------------------------------------------------------ */

interface EngineOpts {
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
}

/** POSTs to the engine route with a timeout, abort support, and retry on
 * rate-limits / upstream 5xx. Deterministic failures (no route, bad input)
 * are NOT retried. */
async function engine<T>(tool: string, params: Record<string, unknown>, opts: EngineOpts = {}): Promise<T> {
  const { signal, retries = 2, timeoutMs = 15_000 } = opts;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let message: string;
    let retryable: boolean;
    try {
      const res = await fetch(ENGINE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, params }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok !== false) return data as T;

      message = data?.error ?? res.statusText ?? `Engine call failed: ${tool}`;
      retryable = res.status === 429 || res.status === 503 || /failed: (429|5\d\d)\b/.test(message);
    } catch {
      if (signal?.aborted) throw abortError();
      message = ctrl.signal.aborted ? `Engine timed out (${tool})` : `Network error reaching engine (${tool})`;
      retryable = true;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!retryable || attempt >= retries) throw new BatchError("engine", message);
    await sleep(400 * 2 ** attempt + Math.random() * 250, signal);
  }
}

/* ------------------------------------------------------------------ */
/* Allocation + timing (pure — unit-testable)                         */
/* ------------------------------------------------------------------ */

/**
 * Buy-side SOL split, in lamports, keyed by wallet id.
 * "equal" preserves the total exactly (remainder goes to the last wallet),
 * even with amount jitter — so you never deploy more or less than you typed.
 */
export function allocateBuy(
  spec: AllocationSpec,
  walletIds: string[],
  amountJitterPct = 0,
  rng: () => number = Math.random
): Record<string, number> {
  const out: Record<string, number> = {};
  const n = walletIds.length;
  if (n === 0) return out;

  if (spec.kind === "fixed") {
    const each = solToLamports(spec.perWalletSol);
    walletIds.forEach((id) => (out[id] = each));
    return out;
  }

  if (spec.kind === "custom") {
    walletIds.forEach((id) => (out[id] = solToLamports(spec.solByWallet[id] ?? 0)));
    return out;
  }

  const total = solToLamports(spec.totalSol);
  const j = clamp(amountJitterPct, 0, 25) / 100;
  const weights = walletIds.map(() => 1 + (rng() * 2 - 1) * j);
  const sumW = weights.reduce((a, b) => a + b, 0);

  let assigned = 0;
  walletIds.forEach((id, i) => {
    const share = i === n - 1 ? total - assigned : Math.floor((total * weights[i]) / sumW);
    out[id] = share;
    assigned += share;
  });
  return out;
}

/**
 * Per-leg fire delays (ms), index-aligned to the legs. Non-simultaneous modes
 * also randomise WHICH wallet goes first, so wallet order can't be fingerprinted.
 */
export function computeDelays(count: number, timing: TimingOptions, rng: () => number = Math.random): number[] {
  const delays = new Array<number>(count).fill(0);
  if (timing.mode === "simultaneous" || count <= 1) return delays;

  const order = shuffle(
    Array.from({ length: count }, (_, i) => i),
    rng
  );
  const step = clamp(timing.staggerMs, 0, MAX_STAGGER_MS);
  const spread = timing.mode === "jitter" ? clamp(timing.jitterMs, 0, MAX_JITTER_MS) : 0;

  order.forEach((legIndex, slot) => {
    const wobble = spread ? (rng() * 2 - 1) * spread : 0;
    delays[legIndex] = clamp(Math.round(slot * step + wobble), 0, MAX_TOTAL_DELAY_MS);
  });
  return delays;
}

export function normalizeSettings(s: BatchSettings): BatchSettings {
  const validTier = (["standard", "fast", "turbo"] as PriorityTier[]).includes(s.priorityTier);
  const validMode = (["simultaneous", "stagger", "jitter"] as TimingMode[]).includes(s.timing.mode);
  return {
    slippageBps: Math.round(clamp(s.slippageBps, MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)),
    priorityTier: validTier ? s.priorityTier : "standard",
    maxPriceImpactPct: clamp(s.maxPriceImpactPct, 0.1, 100),
    timing: {
      mode: validMode ? s.timing.mode : "simultaneous",
      staggerMs: clamp(s.timing.staggerMs, 0, MAX_STAGGER_MS),
      jitterMs: clamp(s.timing.jitterMs, 0, MAX_JITTER_MS),
      amountJitterPct: clamp(s.timing.amountJitterPct, 0, 25),
    },
  };
}

/** "Emergency Sell All" preset: get out now, accept the price. */
export function applyEmergencyOverrides(s: BatchSettings): BatchSettings {
  return {
    slippageBps: Math.max(s.slippageBps, EMERGENCY_MIN_SLIPPAGE_BPS),
    priorityTier: "turbo",
    maxPriceImpactPct: EMERGENCY_MAX_IMPACT_PCT,
    timing: { ...s.timing, mode: "simultaneous", amountJitterPct: 0 },
  };
}

/* ------------------------------------------------------------------ */
/* On-chain reads                                                     */
/* ------------------------------------------------------------------ */

/** Native SOL balances (lamports) for several wallets in ONE RPC call. */
export async function fetchSolBalances(connection: Connection, addresses: string[]): Promise<Record<string, number>> {
  if (addresses.length === 0) return {};
  const infos = await connection.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)));
  const out: Record<string, number> = {};
  infos.forEach((info, i) => (out[addresses[i]] = info?.lamports ?? 0));
  return out;
}

/** Raw token balance for one mint. Filtering by mint (not program) covers
 * both classic SPL and Token-2022. If a wallet somehow has several accounts
 * for the mint, the largest one is used — that's the one Jupiter sells from. */
async function fetchTokenBalanceRaw(connection: Connection, owner: string, mint: string): Promise<string> {
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  let best = BigInt(0);
  for (const acc of res.value) {
    const amount = acc.account.data.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === "string") {
      const v = BigInt(amount);
      if (v > best) best = v;
    }
  }
  return best.toString();
}

export async function fetchMintDecimals(connection: Connection, mint: string): Promise<number> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const data = info.value?.data;
  if (!data || !("parsed" in data) || data.parsed?.type !== "mint") {
    throw new BatchError("invalid_input", "That address isn't a token mint on Solana mainnet.");
  }
  return Number(data.parsed.info.decimals);
}

export function validateMint(input: string): string {
  const mint = input.trim();
  if (!mint) throw new BatchError("invalid_input", "Paste a token mint address first.");
  try {
    new PublicKey(mint);
  } catch {
    throw new BatchError("invalid_input", "That isn't a valid Solana address.");
  }
  if (mint === WSOL_MINT) throw new BatchError("invalid_input", "Pick a token other than SOL.");
  return mint;
}

/* ------------------------------------------------------------------ */
/* Plan (pre-flight)                                                  */
/* ------------------------------------------------------------------ */

export type LegPreflight =
  | "ok"
  | "zero_amount"
  | "insufficient_sol"
  | "no_token_balance"
  | "no_route"
  | "high_impact"
  | "quote_failed";

export interface PlannedLeg {
  walletId: string;
  label: string;
  publicKey: string;
  /** Base units of the INPUT mint (lamports for buys, raw tokens for sells). */
  inAmount: string;
  solBalanceLamports: number;
  tokenBalanceRaw?: string;
  preflight: LegPreflight;
  issue?: string;
  expectedOut?: string; // base units of the OUTPUT mint
  minOut?: string;
  priceImpactPct?: number;
  delayMs: number;
}

export interface BatchPlan {
  id: string;
  side: BatchSide;
  emergency: boolean;
  mint: string;
  mintDecimals: number;
  inputMint: string;
  outputMint: string;
  /** Sell only: % of each wallet's balance being sold. */
  sellPercent: number | null;
  settings: BatchSettings;
  legs: PlannedLeg[];
  createdAt: number;
  totals: { executable: number; flagged: number; deployLamports: number };
}

export interface PrepareInput {
  side: BatchSide;
  mint: string;
  wallets: { id: string; label: string; publicKey: string }[];
  allocation: AllocationSpec;
  /** Sell only: 1–100 (% of each wallet's balance). */
  sellPercent: number;
  settings: BatchSettings;
  emergency?: boolean;
  signal?: AbortSignal;
  log?: LogFn;
}

interface QuoteResponse {
  quote: { outAmount: string; otherAmountThreshold?: string; priceImpactPct?: string };
}

/**
 * Builds a reviewable plan. Reads balances, verifies every wallet can afford
 * its leg (incl. fees + rent), fetches one Jupiter quote per leg IN PARALLEL,
 * applies the price-impact guard, and schedules fire times. Signs and sends
 * NOTHING. Legs that fail a gate stay in the plan flagged, so the user sees
 * exactly which wallets will be skipped and why.
 */
export async function prepareBatch(connection: Connection, input: PrepareInput): Promise<BatchPlan> {
  const { side, wallets, signal, log } = input;
  const settings = normalizeSettings(input.settings);

  if (wallets.length === 0) throw new BatchError("invalid_input", "Select at least one wallet.");
  if (wallets.length > MAX_BATCH_WALLETS) {
    throw new BatchError("invalid_input", `A batch supports at most ${MAX_BATCH_WALLETS} wallets.`);
  }

  const mint = validateMint(input.mint);
  const inputMint = side === "buy" ? WSOL_MINT : mint;
  const outputMint = side === "buy" ? mint : WSOL_MINT;
  const priorityLamports = PRIORITY_TIER_LAMPORTS[settings.priorityTier];

  if (side === "buy") {
    const alloc = input.allocation;
    const hasAmount =
      alloc.kind === "equal"
        ? alloc.totalSol > 0
        : alloc.kind === "fixed"
        ? alloc.perWalletSol > 0
        : wallets.some((w) => (alloc.solByWallet[w.id] ?? 0) > 0);
    if (!hasAmount) throw new BatchError("invalid_input", "Enter a SOL amount to deploy.");
  }

  log?.(`[BATCH]: Pre-flight — ${side} ${shortAddress(mint, 6, 4)} across ${wallets.length} wallet(s)...`);

  let mintDecimals: number;
  let solBalances: Record<string, number>;
  let tokenBalances: string[];
  try {
    [mintDecimals, solBalances, tokenBalances] = await Promise.all([
      fetchMintDecimals(connection, mint),
      fetchSolBalances(connection, wallets.map((w) => w.publicKey)),
      side === "sell"
        ? Promise.all(wallets.map((w) => fetchTokenBalanceRaw(connection, w.publicKey, mint)))
        : Promise.resolve([] as string[]),
    ]);
  } catch (err) {
    if (err instanceof BatchError) throw err;
    throw new BatchError("rpc", `Couldn't read on-chain balances: ${humanizeError(err)}`);
  }
  throwIfAborted(signal);

  // ---- Per-wallet amounts + balance gates --------------------------------
  const buyLamports =
    side === "buy"
      ? allocateBuy(
          input.allocation,
          wallets.map((w) => w.id),
          settings.timing.amountJitterPct
        )
      : {};
  const percentBp = Math.round(clamp(input.sellPercent, 1, 100) * 100);

  const legs: PlannedLeg[] = wallets.map((w, i) => {
    const solBalanceLamports = solBalances[w.publicKey] ?? 0;
    const base = {
      walletId: w.id,
      label: w.label,
      publicKey: w.publicKey,
      solBalanceLamports,
      delayMs: 0,
    };

    if (side === "buy") {
      const alloc = buyLamports[w.id] ?? 0;
      if (alloc <= 0) {
        return { ...base, inAmount: "0", preflight: "zero_amount", issue: "No SOL amount set" };
      }
      const needed = alloc + BASE_FEE_RESERVE_LAMPORTS + priorityLamports;
      if (solBalanceLamports < needed) {
        return {
          ...base,
          inAmount: String(alloc),
          preflight: "insufficient_sol",
          issue: `Needs ${fmtSol(needed)} SOL incl. fees — has ${fmtSol(solBalanceLamports)}`,
        };
      }
      return { ...base, inAmount: String(alloc), preflight: "ok" };
    }

    const tokenBalanceRaw = tokenBalances[i] ?? "0";
    const sellAmount = (BigInt(tokenBalanceRaw) * BigInt(percentBp)) / BigInt(10_000);
    if (sellAmount <= BigInt(0)) {
      return { ...base, inAmount: "0", tokenBalanceRaw, preflight: "no_token_balance", issue: "Holds none of this token" };
    }
    const needed = SELL_FEE_RESERVE_LAMPORTS + priorityLamports;
    if (solBalanceLamports < needed) {
      return {
        ...base,
        inAmount: sellAmount.toString(),
        tokenBalanceRaw,
        preflight: "insufficient_sol",
        issue: `Needs ${fmtSol(needed)} SOL for fees — has ${fmtSol(solBalanceLamports)}`,
      };
    }
    return { ...base, inAmount: sellAmount.toString(), tokenBalanceRaw, preflight: "ok" };
  });

  // ---- Parallel Jupiter quotes for every leg that passed the balance gate --
  await Promise.all(
    legs.map(async (leg) => {
      if (leg.preflight !== "ok") return;
      try {
        const { quote } = await engine<QuoteResponse>(
          "jupiter-quote",
          { inputMint, outputMint, amount: leg.inAmount, slippageBps: settings.slippageBps },
          { signal }
        );
        leg.expectedOut = quote.outAmount;
        leg.minOut = quote.otherAmountThreshold;

        // Jupiter reports priceImpactPct as a ratio (0.01 = 1%).
        const impact = Math.abs(Number(quote.priceImpactPct ?? 0)) * 100;
        leg.priceImpactPct = Number.isFinite(impact) ? impact : 0;
        if (leg.priceImpactPct > settings.maxPriceImpactPct) {
          leg.preflight = "high_impact";
          leg.issue = `Price impact ${leg.priceImpactPct.toFixed(1)}% exceeds your ${settings.maxPriceImpactPct}% limit`;
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        const msg = errMessage(err);
        if (/route|COULD_NOT_FIND/i.test(msg)) {
          leg.preflight = "no_route";
          leg.issue = "No swap route found for this size";
        } else {
          leg.preflight = "quote_failed";
          leg.issue = `Quote failed: ${msg}`;
        }
      }
    })
  );
  throwIfAborted(signal);

  // ---- Schedule fire times (only among legs that will actually run) -------
  const runnable = legs.map((l, i) => (l.preflight === "ok" ? i : -1)).filter((i) => i >= 0);
  const delays = computeDelays(runnable.length, settings.timing);
  runnable.forEach((legIndex, k) => (legs[legIndex].delayMs = delays[k]));

  const executableLegs = legs.filter((l) => l.preflight === "ok");
  const plan: BatchPlan = {
    id: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    side,
    emergency: !!input.emergency,
    mint,
    mintDecimals,
    inputMint,
    outputMint,
    sellPercent: side === "sell" ? clamp(input.sellPercent, 1, 100) : null,
    settings,
    legs,
    createdAt: Date.now(),
    totals: {
      executable: executableLegs.length,
      flagged: legs.length - executableLegs.length,
      deployLamports: side === "buy" ? executableLegs.reduce((sum, l) => sum + Number(l.inAmount), 0) : 0,
    },
  };

  log?.(
    `[BATCH]: Plan ready — ${plan.totals.executable}/${legs.length} wallet(s) cleared` +
      (plan.totals.flagged ? `, ${plan.totals.flagged} flagged.` : ".")
  );
  return plan;
}

/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */

export type LegStatus =
  | "queued"
  | "waiting"
  | "building"
  | "signing"
  | "sending"
  | "confirming"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export interface LegState {
  walletId: string;
  label: string;
  publicKey: string;
  status: LegStatus;
  /** Human-readable sub-step while a leg is in flight. */
  stage?: string;
  inAmount: string;
  expectedOut?: string;
  delayMs: number;
  signature?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export const isTerminalStatus = (s: LegStatus) =>
  s === "success" || s === "failed" || s === "skipped" || s === "cancelled";

/** The three states a trader cares about, plus the two "didn't run" ones. */
export type LegBucket = "pending" | "success" | "failed" | "skipped";

export function legBucket(s: LegStatus): LegBucket {
  if (s === "success") return "success";
  if (s === "failed") return "failed";
  if (s === "skipped" || s === "cancelled") return "skipped";
  return "pending";
}

export function summarizeLegs(legs: LegState[]) {
  const counts = { pending: 0, success: 0, failed: 0, skipped: 0 };
  for (const l of legs) counts[legBucket(l.status)]++;
  return counts;
}

/** Starting state for every leg — flagged legs begin as "skipped" with their reason. */
export function initialLegStates(plan: BatchPlan): LegState[] {
  return plan.legs.map((l) => ({
    walletId: l.walletId,
    label: l.label,
    publicKey: l.publicKey,
    status: l.preflight === "ok" ? "queued" : "skipped",
    inAmount: l.inAmount,
    expectedOut: l.expectedOut,
    delayMs: l.delayMs,
    error: l.preflight === "ok" ? undefined : l.issue,
  }));
}

export interface ExecuteOptions {
  /** Resolves a signing key at the moment a leg fires. Must never be cached. */
  resolveKeypair: (walletId: string) => Keypair;
  /** Called with an immutable snapshot every time a leg changes. */
  onLeg: (leg: LegState) => void;
  /** Aborting stops legs that haven't broadcast yet. A broadcast tx can't be recalled. */
  signal?: AbortSignal;
  log?: LogFn;
}

export interface BatchResult {
  planId: string;
  legs: LegState[];
  aborted: boolean;
  counts: ReturnType<typeof summarizeLegs>;
}

interface SwapBuildResponse {
  swapTransaction: string | null;
  lastValidBlockHeight?: number;
  warning?: string;
}

/**
 * Runs every cleared leg in parallel. Each leg independently waits out its
 * own delay, then: build (fresh quote, server) → sign (local) → broadcast
 * (client RPC) → confirm. One leg failing never affects the others, and this
 * function never rejects — failures are reported per leg via `onLeg`.
 */
export async function executeBatch(
  connection: Connection,
  plan: BatchPlan,
  opts: ExecuteOptions
): Promise<BatchResult> {
  const { resolveKeypair, onLeg, signal, log } = opts;
  const priorityLamports = PRIORITY_TIER_LAMPORTS[plan.settings.priorityTier];

  const legs = initialLegStates(plan);
  legs.forEach(onLeg);

  const commit = (i: number, patch: Partial<LegState>) => {
    legs[i] = { ...legs[i], ...patch };
    onLeg(legs[i]);
  };

  log?.(`[BATCH]: Firing ${plan.totals.executable} leg(s) — ${plan.side.toUpperCase()} ${shortAddress(plan.mint, 6, 4)}`);

  async function runLeg(leg: PlannedLeg, i: number) {
    try {
      if (leg.delayMs > 0) {
        commit(i, { status: "waiting", stage: `Firing in ${(leg.delayMs / 1000).toFixed(1)}s` });
        await sleep(leg.delayMs, signal);
      }
      throwIfAborted(signal);

      commit(i, { status: "building", stage: "Fetching quote & building swap", startedAt: Date.now() });
      const kp = resolveKeypair(leg.walletId);
      if (kp.publicKey.toBase58() !== leg.publicKey) {
        throw new BatchError("invalid_input", "Wallet key changed since review — re-run the batch.");
      }

      const swap = await engine<SwapBuildResponse>(
        "execute-swap-order",
        {
          chain: "solana",
          inputMint: plan.inputMint,
          outputMint: plan.outputMint,
          amount: leg.inAmount,
          userPublicKey: leg.publicKey,
          slippageBps: plan.settings.slippageBps,
          priorityFeeLamports: priorityLamports,
        },
        { signal }
      );
      if (!swap.swapTransaction) {
        throw new BatchError("no_tx", swap.warning ?? "Engine returned no transaction to sign.");
      }
      throwIfAborted(signal);

      commit(i, { status: "signing", stage: "Signing locally" });
      const tx = VersionedTransaction.deserialize(base64ToBytes(swap.swapTransaction));
      tx.sign([kp]);

      // Last point where a cancel is still clean — after this the tx is public.
      throwIfAborted(signal);

      commit(i, { status: "sending", stage: "Broadcasting" });
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      commit(i, { status: "confirming", stage: "Confirming", signature });
      const lastValidBlockHeight =
        swap.lastValidBlockHeight ?? (await connection.getLatestBlockhash()).lastValidBlockHeight;
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new BatchError("rpc", `Failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      commit(i, { status: "success", stage: undefined, finishedAt: Date.now() });
      log?.(`[BATCH]: ${leg.label} ✓ ${signature.slice(0, 8)}…`);
    } catch (err) {
      if (isAbort(err)) {
        commit(i, { status: "cancelled", stage: undefined, error: "Cancelled before broadcast", finishedAt: Date.now() });
        log?.(`[BATCH]: ${leg.label} cancelled.`);
      } else {
        const message = humanizeError(err);
        commit(i, { status: "failed", stage: undefined, error: message, finishedAt: Date.now() });
        log?.(`[BATCH]: ${leg.label} FAILED — ${message}`);
      }
    }
  }

  await Promise.all(plan.legs.map((leg, i) => (leg.preflight === "ok" ? runLeg(leg, i) : Promise.resolve())));

  const counts = summarizeLegs(legs);
  log?.(`[BATCH]: Done — ${counts.success} filled, ${counts.failed} failed, ${counts.skipped} skipped.`);
  return { planId: plan.id, legs, aborted: !!signal?.aborted, counts };
}
