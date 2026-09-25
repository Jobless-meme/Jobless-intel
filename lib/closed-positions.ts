/**
 * Closed-trade derivation — pure, isomorphic (no React, no browser APIs).
 *
 * Turns the buy/sell log that lib/wallet-pnl.ts already extracts from a
 * wallet's own on-chain history into per-sell "closed trades" with a real
 * cost basis (FIFO), so the same numbers can drive:
 *   - the Share PnL cards (client, components/ClosedTradesPanel.tsx)
 *   - the leaderboard stats (server, app/api/v1/leaderboard/sync)
 * Because both sides run THIS function over THE CHAIN's data, the client
 * can't feed the leaderboard a number the chain doesn't back up.
 *
 * Honest limits (same family as wallet-pnl.ts — this is a wallet-history
 * approximation, not audit-grade accounting):
 *   - SOL amounts are net wallet SOL deltas, so they include network/priority
 *     fees, Jito tips and ATA rent. That's what the trader actually gained
 *     or lost, but it isn't the swap's quoted price.
 *   - Multi-hop routes can misattribute some of the SOL delta.
 *   - Only the scanned signature window is seen; tokens acquired before it
 *     have no known cost basis (see `eligible`).
 */

import type { RealizedTrade } from "./wallet-pnl";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const STABLE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/** Below this a "trade" moved almost no SOL — it's a token transfer (or a
 * dust airdrop), not a swap, and must never produce an ROI figure. */
export const MIN_TRADE_SOL = 0.001;

/** A closed trade only counts for leaderboard stats if its cost basis is at
 * least this big. Stops a 0.000005 SOL "buy" (really a transfer-in) from
 * turning into a +2,000,000% best trade. */
export const MIN_ELIGIBLE_COST_SOL = 0.02;

/** A sell must be at least this fraction covered by known buys to count. */
const MIN_BASIS_COVERAGE = 0.95;

export interface ClosedPosition {
  /** `${sellSignature}:${mint}` — stable across rescans. */
  id: string;
  mint: string;
  /** UI-unit tokens matched against known buys (the part with a real cost basis). */
  tokenAmount: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  roiPct: number;
  /** SOL per token. */
  entryPriceSol: number;
  exitPriceSol: number;
  openedAt: number; // ms, earliest matched buy
  closedAt: number; // ms, the sell
  sellSignature: string;
  /** Counts toward leaderboard stats: full cost basis, real size, no free tokens. */
  eligible: boolean;
}

interface Lot {
  tokenAmount: number;
  solAmount: number;
  timestamp: number;
  free: boolean; // arrived with ~no SOL leg — transfer / airdrop
}

export function isTrackableMint(mint: string): boolean {
  return mint !== SOL_MINT && !STABLE_MINTS.has(mint);
}

export function deriveClosedPositions(trades: RealizedTrade[]): ClosedPosition[] {
  const sorted = trades.filter((t) => isTrackableMint(t.mint)).sort((a, b) => a.timestamp - b.timestamp);
  const lotsByMint = new Map<string, Lot[]>();
  const out: ClosedPosition[] = [];

  for (const t of sorted) {
    if (!(t.tokenAmount > 0)) continue;
    const lots = lotsByMint.get(t.mint) ?? [];
    lotsByMint.set(t.mint, lots);

    if (t.side === "buy") {
      lots.push({
        tokenAmount: t.tokenAmount,
        solAmount: t.solAmount,
        timestamp: t.timestamp,
        free: t.solAmount < MIN_TRADE_SOL,
      });
      continue;
    }

    // Sell: consume lots FIFO. Do this even for transfer-outs so token
    // quantities stay consistent with what the wallet actually held.
    let remaining = t.tokenAmount;
    let matched = 0;
    let cost = 0;
    let openedAt = Infinity;
    let touchedFree = false;

    while (remaining > 1e-9 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.tokenAmount, remaining);
      const costShare = (take / lot.tokenAmount) * lot.solAmount;

      matched += take;
      cost += costShare;
      openedAt = Math.min(openedAt, lot.timestamp);
      if (lot.free) touchedFree = true;

      lot.tokenAmount -= take;
      lot.solAmount -= costShare;
      remaining -= take;
      if (lot.tokenAmount <= 1e-9) lots.shift();
    }

    if (matched <= 1e-9) continue; // no known basis at all
    if (t.solAmount < MIN_TRADE_SOL) continue; // transfer-out, not a sale

    const coverage = matched / t.tokenAmount;
    const proceeds = t.solAmount * coverage;
    const pnl = proceeds - cost;

    out.push({
      id: `${t.signature}:${t.mint}`,
      mint: t.mint,
      tokenAmount: matched,
      costSol: cost,
      proceedsSol: proceeds,
      pnlSol: pnl,
      roiPct: cost > 0 ? (pnl / cost) * 100 : 0,
      entryPriceSol: cost / matched,
      exitPriceSol: proceeds / matched,
      openedAt,
      closedAt: t.timestamp,
      sellSignature: t.signature,
      eligible: coverage >= MIN_BASIS_COVERAGE && cost >= MIN_ELIGIBLE_COST_SOL && !touchedFree,
    });
  }

  return out.sort((a, b) => b.closedAt - a.closedAt);
}
