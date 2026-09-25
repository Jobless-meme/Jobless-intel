/**
 * Leaderboard aggregates — pure. Fed by deriveClosedPositions() over a
 * wallet's on-chain history; the sync route (server) is the only writer of
 * these numbers into user_trade_stats.
 */

import type { RealizedTrade } from "./wallet-pnl";
import { MIN_TRADE_SOL, isTrackableMint, type ClosedPosition } from "./closed-positions";

export interface TradeStats {
  tradesClosed: number;
  wins: number;
  winRatePct: number;
  /** Buy + sell SOL notional over the scanned window (token swaps only). */
  totalVolumeSol: number;
  totalRealizedSol: number;
  bestRoiPct: number | null;
  bestRoiMint: string | null;
  bestRoiSignature: string | null;
}

export function computeTradeStats(trades: RealizedTrade[], positions: ClosedPosition[]): TradeStats {
  const eligible = positions.filter((p) => p.eligible);
  const wins = eligible.filter((p) => p.pnlSol > 0).length;

  let best: ClosedPosition | null = null;
  for (const p of eligible) if (!best || p.roiPct > best.roiPct) best = p;

  const totalVolumeSol = trades
    .filter((t) => isTrackableMint(t.mint) && t.solAmount >= MIN_TRADE_SOL)
    .reduce((sum, t) => sum + t.solAmount, 0);

  return {
    tradesClosed: eligible.length,
    wins,
    winRatePct: eligible.length ? (wins / eligible.length) * 100 : 0,
    totalVolumeSol,
    totalRealizedSol: eligible.reduce((sum, p) => sum + p.pnlSol, 0),
    bestRoiPct: best ? best.roiPct : null,
    bestRoiMint: best ? best.mint : null,
    bestRoiSignature: best ? best.sellSignature : null,
  };
}
