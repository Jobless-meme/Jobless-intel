"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Client for PumpPortal's free public WebSocket (wss://pumpportal.fun/api/data).
 * No API key, no rate limit on the data stream (their trading/HTTP API is the
 * paid part — we don't use that here, everything below is read-only data).
 *
 * NOTE: this sandbox has no network access, so this hasn't been exercised
 * against a live connection. The message shapes below are reconstructed
 * from PumpPortal's public docs/examples — verify field names against a
 * real connection (open dev tools -> Network -> WS) before relying on it,
 * and adjust the parsing in `normalize*` below if anything's off.
 */

const PUMP_WS_URL = "wss://pumpportal.fun/api/data";

// pump.fun's classic bonding curve completes around ~85 SOL raised, at
// which point it migrates to an AMM (Raydium). Treat that as the 100%
// mark for "almost bonded" progress. Tune if pump.fun changes curve params.
export const BONDING_COMPLETION_SOL = 85;

export interface PumpNewToken {
  mint: string;
  name: string;
  symbol: string;
  imageUri?: string;
  creator: string;
  solAmount: number;
  marketCapSol: number;
  vSolInBondingCurve: number;
  vTokensInBondingCurve: number;
  bondingProgressPct: number;
  createdAt: number;
}

export interface PumpTradeEvent {
  mint: string;
  trader: string;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  marketCapSol: number;
  vSolInBondingCurve: number;
  bondingProgressPct: number;
  signature: string;
  timestamp: number;
}

function normalizeNewToken(raw: any): PumpNewToken {
  const vSol = Number(raw.vSolInBondingCurve ?? 0);
  return {
    mint: raw.mint,
    name: raw.name ?? "Unknown",
    symbol: raw.symbol ?? "?",
    imageUri: raw.uri,
    creator: raw.traderPublicKey,
    solAmount: Number(raw.solAmount ?? 0),
    marketCapSol: Number(raw.marketCapSol ?? 0),
    vSolInBondingCurve: vSol,
    vTokensInBondingCurve: Number(raw.vTokensInBondingCurve ?? 0),
    bondingProgressPct: Math.min(100, (vSol / BONDING_COMPLETION_SOL) * 100),
    createdAt: Date.now(),
  };
}

function normalizeTrade(raw: any): PumpTradeEvent {
  const vSol = Number(raw.vSolInBondingCurve ?? 0);
  return {
    mint: raw.mint,
    trader: raw.traderPublicKey,
    isBuy: raw.txType === "buy" || raw.is_buy === true,
    solAmount: Number(raw.solAmount ?? 0),
    tokenAmount: Number(raw.tokenAmount ?? 0),
    marketCapSol: Number(raw.marketCapSol ?? 0),
    vSolInBondingCurve: vSol,
    bondingProgressPct: Math.min(100, (vSol / BONDING_COMPLETION_SOL) * 100),
    signature: raw.signature,
    timestamp: Date.now(),
  };
}

type Listener = (msg: any) => void;

/** Single shared WS connection + reconnect-with-backoff, so every hook
 * that wants PumpPortal data doesn't open its own socket. */
class PumpPortalClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>(); // JSON-stringified subscribe messages already sent
  private reconnectDelay = 1000;
  private connecting = false;

  connect() {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    const ws = new WebSocket(PUMP_WS_URL);

    ws.addEventListener("open", () => {
      this.connecting = false;
      this.reconnectDelay = 1000;
      // Replay subscriptions on (re)connect.
      for (const sub of this.subscribed) ws.send(sub);
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.listeners.forEach((l) => l(msg));
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.connecting = false;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    });

    ws.addEventListener("error", () => ws.close());

    this.ws = ws;
  }

  subscribe(message: object) {
    const payload = JSON.stringify(message);
    this.subscribed.add(payload);
    this.connect();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
  }

  addListener(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

let sharedClient: PumpPortalClient | null = null;
function getClient() {
  if (typeof window === "undefined") return null;
  if (!sharedClient) sharedClient = new PumpPortalClient();
  return sharedClient;
}

/** Live stream of newly-created pump.fun tokens, newest first, capped. */
export function usePumpNewTokens(cap = 40) {
  const [tokens, setTokens] = useState<PumpNewToken[]>([]);

  useEffect(() => {
    const client = getClient();
    if (!client) return;
    client.subscribe({ method: "subscribeNewToken" });

    return client.addListener((msg) => {
      if (msg?.txType === "create" || msg?.mint && msg?.name && !msg?.txType) {
        const token = normalizeNewToken(msg);
        setTokens((prev) => [token, ...prev].slice(0, cap));
      }
    });
  }, [cap]);

  return tokens;
}

/** Live bonding-curve trade updates for a specific set of mints — used to
 * track "almost bonded" progress on cards already shown from the New feed. */
export function usePumpTokenTrades(mints: string[]) {
  const [trades, setTrades] = useState<Record<string, PumpTradeEvent>>({});
  const subscribedRef = useRef(new Set<string>());

  useEffect(() => {
    const client = getClient();
    if (!client) return;
    const toSub = mints.filter((m) => !subscribedRef.current.has(m));
    if (toSub.length > 0) {
      client.subscribe({ method: "subscribeTokenTrade", keys: toSub });
      toSub.forEach((m) => subscribedRef.current.add(m));
    }
  }, [mints]);

  useEffect(() => {
    const client = getClient();
    if (!client) return;
    return client.addListener((msg) => {
      if (msg?.mint && msg?.txType && msg.txType !== "create") {
        const trade = normalizeTrade(msg);
        setTrades((prev) => ({ ...prev, [trade.mint]: trade }));
      }
    });
  }, []);

  return trades;
}

/** Live trade feed for specific wallets — the real-time half of the Wallet
 * Tracker / Track tab. Covers pump.fun + Raydium activity that PumpPortal
 * indexes; it does NOT see every DEX (Orca, Meteora, raw Jupiter routes
 * outside their tracked pools) — full coverage needs a real indexer. */
export function useWalletTrades(addresses: string[], cap = 100) {
  const [events, setEvents] = useState<(PumpTradeEvent & { watchedWallet: string })[]>([]);
  const subscribedRef = useRef(new Set<string>());

  useEffect(() => {
    const client = getClient();
    if (!client || addresses.length === 0) return;
    const toSub = addresses.filter((a) => !subscribedRef.current.has(a));
    if (toSub.length > 0) {
      client.subscribe({ method: "subscribeAccountTrade", keys: toSub });
      toSub.forEach((a) => subscribedRef.current.add(a));
    }
  }, [addresses]);

  useEffect(() => {
    const client = getClient();
    if (!client) return;
    return client.addListener((msg) => {
      if (msg?.mint && msg?.traderPublicKey && addresses.includes(msg.traderPublicKey)) {
        const trade = normalizeTrade(msg);
        setEvents((prev) => [{ ...trade, watchedWallet: msg.traderPublicKey }, ...prev].slice(0, cap));
      }
    });
  }, [addresses, cap]);

  return events;
}
