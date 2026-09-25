"use client";

import { Connection, PublicKey, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import type { LogFn } from "./agents-engine";
import { BatchError, humanizeError, lamportsToSol } from "./batch-trading";

/**
 * SOL Withdrawal / Sweep Utility
 * ------------------------------------------------------------------
 * Drains native SOL from one or more local session (burner) wallets back to
 * the user's main wallet. Same zero-custody contract as the batch engine:
 * every leg is a plain SystemProgram.transfer, signed locally with that
 * wallet's own Keypair and broadcast straight from the client's RPC
 * connection. Nothing here ever touches a secret key belonging to any
 * wallet other than the one it's currently sweeping, and nothing — key or
 * transaction — is ever sent to a server.
 *
 * Rent exemption:
 *   Once an account is funded above the rent-exempt minimum, the runtime
 *   will reject any transfer that would leave it with a POSITIVE balance
 *   below that minimum — the only balance below the threshold it will ever
 *   allow is exactly zero. So "leave dust" can't mean an arbitrary tiny
 *   amount: it means leaving exactly the rent-exempt minimum for a bare
 *   (0-byte) system account, currently ~0.00089 SOL. "Empty" drains to
 *   exactly zero instead, after which the wallet needs a fresh top-up
 *   before it can sign anything (a 0-lamport account can still sign; it
 *   just can't pay its own next fee).
 *
 * Flow mirrors lib/batch-trading.ts:
 *   prepareSweep() → balances + rent-exempt minimum + per-wallet gates
 *                    (nothing is signed or sent; returns a reviewable plan)
 *   executeSweep() → per-leg build → sign → send → confirm, all legs in
 *                    parallel, each independent so one failure never blocks
 *                    the rest
 */

export const MAX_SWEEP_WALLETS = 10;

/** Solana's base fee is fixed at 5,000 lamports per signature. A plain
 * single-signer transfer needs no priority fee, so this is the only
 * per-leg reserve. */
export const SWEEP_FEE_RESERVE_LAMPORTS = 5_000;

export type SweepMode = "dust" | "empty";

export interface SweepWalletInput {
  id: string;
  label: string;
  publicKey: string;
}

export type SweepPreflight = "ok" | "below_reserve" | "empty_wallet";

export interface PlannedSweepLeg {
  walletId: string;
  label: string;
  publicKey: string;
  balanceLamports: number;
  /** Lamports that will actually move. 0 unless preflight is "ok". */
  sweepLamports: number;
  preflight: SweepPreflight;
  issue?: string;
}

export interface SweepPlan {
  id: string;
  destination: string;
  mode: SweepMode;
  rentExemptLamports: number;
  legs: PlannedSweepLeg[];
  createdAt: number;
  totals: { executable: number; totalLamports: number };
}

export interface PrepareSweepInput {
  destination: string;
  mode: SweepMode;
  wallets: SweepWalletInput[];
  signal?: AbortSignal;
  log?: LogFn;
}

/** Validates a destination address. `excluding` rejects sweeping a wallet into itself. */
export function validateDestination(input: string, excluding: string[] = []): string {
  const addr = input.trim();
  if (!addr) throw new BatchError("invalid_input", "Enter the main wallet address to sweep into.");
  try {
    new PublicKey(addr);
  } catch {
    throw new BatchError("invalid_input", "That isn't a valid Solana address.");
  }
  if (excluding.includes(addr)) {
    throw new BatchError("invalid_input", "Destination can't be one of the wallets you're sweeping.");
  }
  return addr;
}

async function fetchBalances(connection: Connection, addresses: string[]): Promise<Record<string, number>> {
  if (addresses.length === 0) return {};
  const infos = await connection.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)));
  const out: Record<string, number> = {};
  infos.forEach((info, i) => (out[addresses[i]] = info?.lamports ?? 0));
  return out;
}

/**
 * Builds a reviewable sweep plan. Reads every wallet's balance and the
 * network's current rent-exempt minimum, then computes exactly how much
 * each wallet can send without either going negative or landing in the
 * disallowed "positive but below rent-exempt" zone. Signs and sends
 * NOTHING — wallets that can't clear the reserve stay in the plan flagged
 * so the user sees why they're being skipped.
 */
export async function prepareSweep(connection: Connection, input: PrepareSweepInput): Promise<SweepPlan> {
  const { wallets, mode, signal, log } = input;
  if (wallets.length === 0) throw new BatchError("invalid_input", "Select at least one wallet to sweep.");
  if (wallets.length > MAX_SWEEP_WALLETS) {
    throw new BatchError("invalid_input", `A sweep supports at most ${MAX_SWEEP_WALLETS} wallets.`);
  }

  const destination = validateDestination(
    input.destination,
    wallets.map((w) => w.publicKey)
  );

  log?.(`[SWEEP]: Reading balances for ${wallets.length} wallet(s)...`);

  let balances: Record<string, number>;
  let rentExemptLamports: number;
  try {
    [balances, rentExemptLamports] = await Promise.all([
      fetchBalances(connection, wallets.map((w) => w.publicKey)),
      connection.getMinimumBalanceForRentExemption(0),
    ]);
  } catch (err) {
    throw new BatchError("rpc", `Couldn't read on-chain balances: ${humanizeError(err)}`);
  }
  if (signal?.aborted) throw new BatchError("aborted", "Cancelled");

  const reserve = mode === "dust" ? rentExemptLamports + SWEEP_FEE_RESERVE_LAMPORTS : SWEEP_FEE_RESERVE_LAMPORTS;

  const legs: PlannedSweepLeg[] = wallets.map((w) => {
    const balanceLamports = balances[w.publicKey] ?? 0;

    if (balanceLamports === 0) {
      return {
        walletId: w.id,
        label: w.label,
        publicKey: w.publicKey,
        balanceLamports,
        sweepLamports: 0,
        preflight: "empty_wallet",
        issue: "Nothing to sweep",
      };
    }

    const sweepLamports = balanceLamports - reserve;
    if (sweepLamports <= 0) {
      return {
        walletId: w.id,
        label: w.label,
        publicKey: w.publicKey,
        balanceLamports,
        sweepLamports: 0,
        preflight: "below_reserve",
        issue:
          mode === "dust"
            ? `Below the ${lamportsToSol(reserve).toFixed(5)} SOL needed to stay rent-exempt plus the tx fee`
            : `Below the ${lamportsToSol(reserve).toFixed(5)} SOL fee reserve`,
      };
    }

    return { walletId: w.id, label: w.label, publicKey: w.publicKey, balanceLamports, sweepLamports, preflight: "ok" };
  });

  const executableLegs = legs.filter((l) => l.preflight === "ok");
  const plan: SweepPlan = {
    id: `sweep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    destination,
    mode,
    rentExemptLamports,
    legs,
    createdAt: Date.now(),
    totals: {
      executable: executableLegs.length,
      totalLamports: executableLegs.reduce((sum, l) => sum + l.sweepLamports, 0),
    },
  };

  log?.(
    `[SWEEP]: Plan ready — ${plan.totals.executable}/${legs.length} wallet(s) cleared, ` +
      `${lamportsToSol(plan.totals.totalLamports).toFixed(4)} SOL total.`
  );
  return plan;
}

/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */

export type SweepLegStatus =
  | "queued"
  | "building"
  | "signing"
  | "sending"
  | "confirming"
  | "success"
  | "failed"
  | "skipped"
  | "cancelled";

export interface SweepLegState {
  walletId: string;
  label: string;
  publicKey: string;
  status: SweepLegStatus;
  stage?: string;
  sweepLamports: number;
  signature?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type SweepLegBucket = "pending" | "success" | "failed" | "skipped";

export function sweepLegBucket(s: SweepLegStatus): SweepLegBucket {
  if (s === "success") return "success";
  if (s === "failed") return "failed";
  if (s === "skipped" || s === "cancelled") return "skipped";
  return "pending";
}

/** Starting state for every leg — flagged legs begin as "skipped" with their reason. */
export function initialSweepLegStates(plan: SweepPlan): SweepLegState[] {
  return plan.legs.map((l) => ({
    walletId: l.walletId,
    label: l.label,
    publicKey: l.publicKey,
    status: l.preflight === "ok" ? "queued" : "skipped",
    sweepLamports: l.sweepLamports,
    error: l.preflight === "ok" ? undefined : l.issue,
  }));
}

export interface ExecuteSweepOptions {
  /** Resolves a signing key at the moment a leg fires. Must never be cached. */
  resolveKeypair: (walletId: string) => Keypair;
  /** Called with an immutable snapshot every time a leg changes. */
  onLeg: (leg: SweepLegState) => void;
  /** Aborting stops legs that haven't broadcast yet. A broadcast tx can't be recalled. */
  signal?: AbortSignal;
  log?: LogFn;
}

export interface SweepResult {
  planId: string;
  legs: SweepLegState[];
  aborted: boolean;
  counts: { pending: number; success: number; failed: number; skipped: number };
}

/**
 * Runs every cleared leg in parallel. Each leg builds a single
 * SystemProgram.transfer, signs it locally, broadcasts from the client RPC,
 * and confirms. One leg failing never affects the others, and this
 * function never rejects — failures are reported per leg via `onLeg`.
 */
export async function executeSweep(connection: Connection, plan: SweepPlan, opts: ExecuteSweepOptions): Promise<SweepResult> {
  const { resolveKeypair, onLeg, signal, log } = opts;

  const legs = initialSweepLegStates(plan);
  legs.forEach(onLeg);

  const commit = (i: number, patch: Partial<SweepLegState>) => {
    legs[i] = { ...legs[i], ...patch };
    onLeg(legs[i]);
  };

  const destination = new PublicKey(plan.destination);
  log?.(`[SWEEP]: Sending ${plan.totals.executable} transfer(s) to ${plan.destination.slice(0, 6)}…`);

  async function runLeg(leg: PlannedSweepLeg, i: number) {
    try {
      if (signal?.aborted) throw new BatchError("aborted", "Cancelled");

      commit(i, { status: "building", stage: "Building transfer", startedAt: Date.now() });
      const kp = resolveKeypair(leg.walletId);
      if (kp.publicKey.toBase58() !== leg.publicKey) {
        throw new BatchError("invalid_input", "Wallet key changed since review — re-run the sweep.");
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: destination, lamports: leg.sweepLamports })
      );

      if (signal?.aborted) throw new BatchError("aborted", "Cancelled");
      commit(i, { status: "signing", stage: "Signing locally" });
      tx.sign(kp);

      // Last point where a cancel is still clean — after this the tx is public.
      if (signal?.aborted) throw new BatchError("aborted", "Cancelled");

      commit(i, { status: "sending", stage: "Broadcasting" });
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });

      commit(i, { status: "confirming", stage: "Confirming", signature });
      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (confirmation.value.err) {
        throw new BatchError("rpc", `Failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      commit(i, { status: "success", stage: undefined, finishedAt: Date.now() });
      log?.(`[SWEEP]: ${leg.label} ✓ ${signature.slice(0, 8)}…`);
    } catch (err) {
      if (err instanceof BatchError && err.code === "aborted") {
        commit(i, { status: "cancelled", stage: undefined, error: "Cancelled before broadcast", finishedAt: Date.now() });
        log?.(`[SWEEP]: ${leg.label} cancelled.`);
      } else {
        const message = humanizeError(err);
        commit(i, { status: "failed", stage: undefined, error: message, finishedAt: Date.now() });
        log?.(`[SWEEP]: ${leg.label} FAILED — ${message}`);
      }
    }
  }

  await Promise.all(plan.legs.map((leg, i) => (leg.preflight === "ok" ? runLeg(leg, i) : Promise.resolve())));

  const counts = { pending: 0, success: 0, failed: 0, skipped: 0 };
  for (const l of legs) counts[sweepLegBucket(l.status)]++;

  log?.(`[SWEEP]: Done — ${counts.success} swept, ${counts.failed} failed, ${counts.skipped} skipped.`);
  return { planId: plan.id, legs, aborted: !!signal?.aborted, counts };
}
