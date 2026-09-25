"use client";

/** Quick Buy presets (P1/P2/P3), persisted per-browser. Backs both the
 * Quick Buy Settings screen and every one-tap Buy button across Trenches
 * and the Wallet Tracker. */

export interface TradePresets {
  amounts: [number, number, number]; // SOL, for P1/P2/P3
  activeSlot: 0 | 1 | 2;
  slippageBps: number;
  antiMev: "off" | "reduced" | "secure";
}

const KEY = "lx_trade_presets_v1";

const DEFAULTS: TradePresets = {
  amounts: [0.1, 0.5, 1],
  activeSlot: 0,
  slippageBps: 100, // 1%
  antiMev: "reduced",
};

export function getTradePresets(): TradePresets {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function saveTradePresets(presets: TradePresets) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(presets));
}

export function getActiveQuickBuyAmount(): number {
  const p = getTradePresets();
  return p.amounts[p.activeSlot];
}
