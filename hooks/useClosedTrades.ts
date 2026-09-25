"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import { fetchRealizedPnl } from "@/lib/wallet-pnl";
import { deriveClosedPositions, type ClosedPosition } from "@/lib/closed-positions";
import { fetchTokenSymbols } from "@/lib/token-symbols";
import type { PnlCardData } from "@/lib/pnl-card-renderer";

/**
 * Closed trades for a wallet, derived from its own on-chain history (the
 * same wallet-pnl scan the Portfolio tab uses) — so it also catches exits
 * that never touched this tab: Jupiter keeper-filled TP/SL orders, manual
 * sells, batch sells.
 *
 * Module-level store, same pattern as hooks/useBatchTrading.ts: the
 * Execution Bay list and the TP/SL panel share ONE scan per wallet instead
 * of each hammering the RPC, and a scan keeps going if a panel unmounts.
 * Scanning is button-driven, never automatic — it's ~1 RPC call per
 * signature and public endpoints rate-limit hard.
 */

export const SCAN_LIMIT = 150;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface ClosedTrade extends ClosedPosition {
  symbol: string;
}

export type ScanStatus = "idle" | "scanning" | "ready" | "error";

interface WalletScanState {
  status: ScanStatus;
  /** 0..1 while scanning. */
  progress: number;
  trades: ClosedTrade[];
  scanned: number;
  truncated: boolean;
  scannedAt: number | null;
  error: string | null;
}

const IDLE: WalletScanState = {
  status: "idle",
  progress: 0,
  trades: [],
  scanned: 0,
  truncated: false,
  scannedAt: null,
  error: null,
};

const states = new Map<string, WalletScanState>();
const listeners = new Set<() => void>();

const getState = (wallet: string | null): WalletScanState => (wallet ? states.get(wallet) ?? IDLE : IDLE);

function setState(wallet: string, patch: Partial<WalletScanState>) {
  states.set(wallet, { ...getState(wallet), ...patch });
  listeners.forEach((l) => l());
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

async function runScan(connection: Connection, wallet: string) {
  const current = getState(wallet);
  if (current.status === "scanning") return;
  setState(wallet, { status: "scanning", progress: 0, error: null });
  try {
    const summary = await fetchRealizedPnl(connection, wallet, SCAN_LIMIT, (done, total) => {
      if (total > 0) setState(wallet, { progress: done / total });
    });
    const positions = deriveClosedPositions(summary.trades);
    const symbols = await fetchTokenSymbols(positions.map((p) => p.mint));
    const trades: ClosedTrade[] = positions.map((p) => ({
      ...p,
      symbol: symbols[p.mint] ?? `${p.mint.slice(0, 4)}…`,
    }));
    setState(wallet, {
      status: "ready",
      progress: 1,
      trades,
      scanned: summary.scannedSignatures,
      truncated: summary.truncated,
      scannedAt: Date.now(),
    });
  } catch (err: any) {
    setState(wallet, { status: "error", error: err?.message ?? "History scan failed" });
  }
}

export function useClosedTrades(walletPublicKey: string | null) {
  const { connection } = useConnection();
  const state = useSyncExternalStore(
    subscribe,
    () => getState(walletPublicKey),
    () => IDLE
  );

  const scan = useCallback(
    (force = false) => {
      if (!walletPublicKey) return;
      const s = getState(walletPublicKey);
      const fresh = s.scannedAt != null && Date.now() - s.scannedAt < CACHE_TTL_MS;
      if (s.status === "scanning" || (fresh && !force)) return;
      void runScan(connection, walletPublicKey);
    },
    [connection, walletPublicKey]
  );

  return { ...state, scan };
}

/** ClosedTrade → the share card's input. */
export function closedTradeToCard(trade: ClosedTrade, walletAddress: string): PnlCardData {
  return {
    symbol: trade.symbol,
    status: "closed",
    priceUnit: "SOL",
    entryPrice: trade.entryPriceSol,
    exitPrice: trade.exitPriceSol,
    roiPct: trade.roiPct,
    pnlSol: trade.pnlSol,
    costSol: trade.costSol,
    walletAddress,
    txSignature: trade.sellSignature,
    onChainVerified: true,
    closedAt: trade.closedAt,
  };
}
