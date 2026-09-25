import "server-only";
import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { resolvePool } from "./chart-feed";

/**
 * SnipeX Creator Scorecard
 * ------------------------------------------------------------------
 * Answers "has this deployer wallet done this before, and how did it go?"
 * by walking its transaction history for pump.fun token-creation
 * instructions, then classifying each prior mint. Same tradeoffs as
 * lib/holder-analysis.ts: everything here is free, keyless, public RPC +
 * GeckoTerminal data, concurrency-limited and depth-capped so it doesn't
 * fall over on a free RPC endpoint or a wallet with thousands of
 * signatures — not a full-history indexer.
 *
 * "Rug" here is a HEURISTIC, not a determination of fraud: a launch is
 * counted as `abandoned` when it never reached a real liquidity pool
 * (never bonded / graduated) AND the deployer's own token balance for
 * that mint is now zero, i.e. the dev walked away from a curve nobody
 * else filled either. That pattern is also indistinguishable from "a
 * token that fairly failed to attract buyers" — this scorecard surfaces
 * the pattern, it doesn't accuse. Label copy in the UI should reflect
 * that (RUG_LIKELY, not "confirmed rug").
 *
 * NOTE: this sandbox has no network access, so this hasn't been run
 * against a live RPC endpoint. Verify PUMP_FUN_PROGRAM_ID and the parsed
 * "create" instruction shape against a real connection before trusting
 * this in production — adjust `extractCreatedMint` if pump.fun's IDL has
 * moved on.
 */

// pump.fun's bonding-curve program. Verify against https://pump.fun docs
// or a live tx before relying on it — program ids don't change often but
// this hasn't been checked against a live endpoint in this environment.
const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const MAX_SIGNATURES_SCANNED = 200; // depth cap on the deployer's own history
const MAX_PRIOR_MINTS_CLASSIFIED = 25; // depth cap on how many past launches get the full classify pass
const CONCURRENCY = 4;

export type CreatorRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "RUG_LIKELY";

export interface PriorLaunch {
  mint: string;
  createdAt: number | null;
  signature: string;
  /** true once it has a real DEX pool (graduated off the bonding curve). */
  graduated: boolean;
  /** true when it never graduated AND the dev's own balance is now 0 — see module doc. */
  abandoned: boolean;
  liquidityUsd: number | null;
}

export interface CreatorAudit {
  creator: string;
  fetchedAt: number;
  totalLaunches: number;
  graduatedCount: number;
  abandonedCount: number;
  completionRatePct: number;
  riskLevel: CreatorRiskLevel;
  launches: PriorLaunch[];
  /** true if the signature scan hit MAX_SIGNATURES_SCANNED without exhausting history — counts are a floor, not exact. */
  partial: boolean;
}

/** Simple bounded-concurrency map — same shallow-scan spirit as
 * lib/holder-analysis.ts's funder trace, kept local rather than pulling
 * in a queue library for one call site. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Pulls the mint address out of a parsed pump.fun "create" instruction.
 * pump.fun's create ix lists the new mint as one of the instruction's
 * accounts (index 0 in every observed layout at time of writing) —
 * verify this against a live tx, IDLs drift. */
function extractCreatedMint(tx: ParsedTransactionWithMeta, creator: string): { mint: string; index: number } | null {
  const allIx = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
  ];
  for (const ix of allIx) {
    if (!("programId" in ix)) continue;
    if (ix.programId.toBase58() !== PUMP_FUN_PROGRAM_ID) continue;
    // Raw (non-parsed) instruction — pump.fun isn't in Solana's default
    // parsed-instruction registry, so we only get an account list, not
    // named fields. accounts[0] is the mint in every observed create ix.
    const raw = ix as { accounts?: PublicKey[] };
    const mint = raw.accounts?.[0];
    if (mint) return { mint: mint.toBase58(), index: 0 };
  }
  void creator;
  return null;
}

/** Walks the deployer's recent signatures looking for pump.fun "create"
 * calls. Returns each prior mint with its creation timestamp, newest
 * first, deduped. */
async function findPriorLaunches(
  connection: Connection,
  creator: string
): Promise<{ launches: { mint: string; createdAt: number | null; signature: string }[]; partial: boolean }> {
  const creatorKey = new PublicKey(creator);
  const sigInfos = await connection.getSignaturesForAddress(creatorKey, { limit: MAX_SIGNATURES_SCANNED });
  const partial = sigInfos.length === MAX_SIGNATURES_SCANNED;

  const seen = new Set<string>();
  const out: { mint: string; createdAt: number | null; signature: string }[] = [];

  // Sequential on purpose: getSignaturesForAddress already gave us the
  // list, and free RPC endpoints tend to rate-limit getParsedTransaction
  // hard — same tradeoff lib/wallet-pnl.ts makes.
  for (const info of sigInfos) {
    if (info.err) continue;
    let tx: ParsedTransactionWithMeta | null = null;
    try {
      tx = await connection.getParsedTransaction(info.signature, { maxSupportedTransactionVersion: 0 });
    } catch {
      continue;
    }
    if (!tx) continue;

    const created = extractCreatedMint(tx, creator);
    if (!created || seen.has(created.mint)) continue;
    seen.add(created.mint);
    out.push({
      mint: created.mint,
      createdAt: (info.blockTime ?? tx.blockTime ?? null) ? (info.blockTime ?? tx.blockTime)! * 1000 : null,
      signature: info.signature,
    });
    if (out.length >= MAX_PRIOR_MINTS_CLASSIFIED) break;
  }

  return { launches: out, partial };
}

/** Classifies one prior launch: did it ever get real liquidity, and does
 * the dev still hold (or ever cashed out of) its own allocation. */
async function classifyLaunch(
  connection: Connection,
  creator: string,
  launch: { mint: string; createdAt: number | null; signature: string }
): Promise<PriorLaunch> {
  let liquidityUsd: number | null = null;
  let graduated = false;
  try {
    const pool = await resolvePool("solana", launch.mint);
    if (pool) {
      graduated = true;
      liquidityUsd = pool.liquidityUsd;
    }
  } catch {
    /* GeckoTerminal miss/rate-limit — treat as "couldn't confirm graduation", not as abandoned by itself */
  }

  let devBalanceZero = false;
  try {
    const mintKey = new PublicKey(launch.mint);
    const creatorKey = new PublicKey(creator);
    const accounts = await connection.getParsedTokenAccountsByOwner(creatorKey, { mint: mintKey });
    const totalUi = accounts.value.reduce((sum, a) => sum + Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
    devBalanceZero = accounts.value.length === 0 || totalUi === 0;
  } catch {
    /* couldn't confirm dev balance — leave devBalanceZero false, don't over-flag on missing data */
  }

  return {
    mint: launch.mint,
    createdAt: launch.createdAt,
    signature: launch.signature,
    graduated,
    abandoned: !graduated && devBalanceZero,
    liquidityUsd,
  };
}

function scoreRisk(graduatedCount: number, abandonedCount: number, total: number): CreatorRiskLevel {
  if (total === 0) return "LOW"; // no history at all — not a red flag by itself, just unknown
  const abandonedRate = abandonedCount / total;
  if (total >= 3 && abandonedRate >= 0.66) return "RUG_LIKELY";
  if (abandonedRate >= 0.4) return "HIGH";
  if (abandonedRate >= 0.15 || (total >= 5 && graduatedCount === 0)) return "MEDIUM";
  return "LOW";
}

/** Full creator scorecard for one deployer wallet. This is the expensive
 * call (N RPC round trips) — callers should cache it, same pattern as
 * app/api/v1/holders/route.ts caches fetchHolderAnalysis. */
export async function auditCreator(connection: Connection, creator: string): Promise<CreatorAudit> {
  const { launches: priors, partial } = await findPriorLaunches(connection, creator);
  const classified = await mapWithConcurrency(priors, CONCURRENCY, (l) => classifyLaunch(connection, creator, l));

  const graduatedCount = classified.filter((l) => l.graduated).length;
  const abandonedCount = classified.filter((l) => l.abandoned).length;
  const total = classified.length;

  return {
    creator,
    fetchedAt: Date.now(),
    totalLaunches: total,
    graduatedCount,
    abandonedCount,
    completionRatePct: total > 0 ? Math.round((graduatedCount / total) * 1000) / 10 : 0,
    riskLevel: scoreRisk(graduatedCount, abandonedCount, total),
    launches: classified.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    partial,
  };
}
