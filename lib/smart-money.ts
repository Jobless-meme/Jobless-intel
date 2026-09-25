"use client";

import type { PumpTradeEvent } from "./pump-portal";
import { getSupabaseBrowserClient } from "./supabase-client";

/**
 * Smart Money & KOL Tracker — filters the same PumpPortal
 * `subscribeAccountTrade` stream the Wallet Tracker tab uses (see
 * `useWalletTrades` in lib/pump-portal.ts) down to a curated/user-managed
 * set of addresses, and tags each trade with an activity type.
 *
 * Deliberately NOT shipped with a pre-seeded list of real "known KOL"
 * wallet addresses — attributing specific trading behavior to a specific
 * real address under a real person's name is exactly the kind of thing
 * that needs the team's own verification before it goes in front of
 * users, not a plausible-looking placeholder from this pass. The curated
 * list (`user_id IS NULL` rows in `smart_money_wallets`) ships empty;
 * `seedCuratedWallet` below is there for your team to populate once
 * you've actually verified addresses. Everything a user adds themselves
 * via `addSmartMoneyWallet` works immediately, no seeding required.
 */

export type WalletTier = "kol" | "smart_money" | "whale";
export type ActivityType = "smart_buy" | "smart_sell" | "heavy_accumulation" | "whale_exit";

export interface SmartMoneyWallet {
  id: string | null; // null for a not-yet-persisted local-only entry
  address: string;
  label: string;
  tier: WalletTier;
  userId: string | null; // null = curated/global, set = one user's personal tag
}

export interface SmartMoneyAlert {
  id: string; // trade signature
  wallet: SmartMoneyWallet;
  mint: string;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  marketCapSol: number;
  entryPriceSol: number; // this trade's executed price, tokens per SOL inverted -> SOL per token
  activityType: ActivityType;
  timestamp: number;
}

export interface WalletWinRateStat {
  winRatePct: number;
  totalRealizedSol: number;
  tradesScanned: number;
  fetchedAt: number;
}

const ACCUMULATION_WINDOW_MS = 10 * 60 * 1000; // 3+ buys on the same mint inside 10 min == accumulating, not just one entry
const ACCUMULATION_MIN_BUYS = 3;
const WHALE_EXIT_SOL_THRESHOLD = 5; // a single sell >= 5 SOL reads as a whale exiting, not a routine trim — tune per token's typical liquidity

export const TIER_LABELS: Record<WalletTier, string> = {
  kol: "KOL",
  smart_money: "Smart Money",
  whale: "Whale",
};

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  smart_buy: "Smart Buy",
  smart_sell: "Smart Sell",
  heavy_accumulation: "Heavy Accumulation",
  whale_exit: "Whale Exit",
};

/** Given a trade and that wallet+mint's prior trade history (most-recent
 * first, not including this trade), decide which badge it earns. Pure
 * function so it's trivially testable without a live feed. */
export function classifyTrade(trade: PumpTradeEvent, priorTradesSameWalletMint: PumpTradeEvent[]): ActivityType {
  if (!trade.isBuy) {
    return trade.solAmount >= WHALE_EXIT_SOL_THRESHOLD ? "whale_exit" : "smart_sell";
  }
  const windowStart = trade.timestamp - ACCUMULATION_WINDOW_MS;
  const recentBuys = priorTradesSameWalletMint.filter((t) => t.isBuy && t.timestamp >= windowStart);
  return recentBuys.length + 1 >= ACCUMULATION_MIN_BUYS ? "heavy_accumulation" : "smart_buy";
}

/** Turns a raw watched-wallet trade stream (as returned by
 * `useWalletTrades`, newest-first) into classified alerts for wallets we
 * actually have tags for. Exported standalone (not just baked into a
 * hook) so it's easy to unit test against a fixture trade array. */
export function buildSmartMoneyAlerts(
  trades: (PumpTradeEvent & { watchedWallet: string })[],
  wallets: SmartMoneyWallet[],
  cap = 60
): SmartMoneyAlert[] {
  const walletByAddress = new Map(wallets.map((w) => [w.address, w] as const));
  const chronological = [...trades].reverse(); // oldest -> newest, so accumulation windows look backward correctly
  const historyByKey = new Map<string, PumpTradeEvent[]>();
  const alerts: SmartMoneyAlert[] = [];

  for (const t of chronological) {
    const wallet = walletByAddress.get(t.watchedWallet);
    if (!wallet) continue;

    const key = `${t.watchedWallet}:${t.mint}`;
    const history = historyByKey.get(key) ?? [];
    const activityType = classifyTrade(t, history);
    const entryPriceSol = t.tokenAmount > 0 ? t.solAmount / t.tokenAmount : 0;

    alerts.push({
      id: t.signature,
      wallet,
      mint: t.mint,
      isBuy: t.isBuy,
      solAmount: t.solAmount,
      tokenAmount: t.tokenAmount,
      marketCapSol: t.marketCapSol,
      entryPriceSol,
      activityType,
      timestamp: t.timestamp,
    });

    historyByKey.set(key, [t, ...history].slice(0, 20));
  }

  return alerts.reverse().slice(0, cap); // back to newest-first for display
}

/* ------------------------------------------------------------------ */
/* Wallet list: curated (global) + personal, Supabase-backed with a     */
/* localStorage fallback so the feature works before/without sign-in.   */
/* ------------------------------------------------------------------ */

const LOCAL_KEY = "lx_smart_money_wallets_v1";

function readLocalWallets(): SmartMoneyWallet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as SmartMoneyWallet[]) : [];
  } catch {
    return [];
  }
}

function writeLocalWallets(wallets: SmartMoneyWallet[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_KEY, JSON.stringify(wallets));
}

/** Curated (user_id IS NULL) wallets are public data, readable even
 * without a Supabase session — RLS on smart_money_wallets allows
 * anonymous SELECT for those rows. Personal wallets need `userId`
 * (from useWalletAuth's `userId` once SIWS-linked); without one, personal
 * tags live in localStorage only until the user signs in. */
export async function fetchSmartMoneyWallets(userId: string | null): Promise<SmartMoneyWallet[]> {
  const local = readLocalWallets();

  let supabase;
  try {
    supabase = getSupabaseBrowserClient();
  } catch {
    return local; // Supabase not configured this deploy — local-only mode
  }

  try {
    const query = supabase.from("smart_money_wallets").select("id, address, label, tier, user_id");
    const { data, error } = userId ? await query.or(`user_id.is.null,user_id.eq.${userId}`) : await query.is("user_id", null);
    if (error) throw error;

    const remote: SmartMoneyWallet[] = (data ?? []).map((r: any) => ({
      id: r.id,
      address: r.address,
      label: r.label,
      tier: r.tier,
      userId: r.user_id,
    }));

    // Merge: prefer the synced remote copy of anything local that made it
    // up, keep any not-yet-synced local-only entries too.
    const remoteAddresses = new Set(remote.map((w) => w.address));
    const localOnly = local.filter((w) => !remoteAddresses.has(w.address));
    return [...remote, ...localOnly];
  } catch {
    return local; // network hiccup — degrade to whatever's cached locally
  }
}

export async function addSmartMoneyWallet(
  userId: string | null,
  wallet: { address: string; label: string; tier: WalletTier }
): Promise<SmartMoneyWallet> {
  const entry: SmartMoneyWallet = { id: null, userId, ...wallet };

  // Always write local first — instant, works offline/signed-out.
  const local = readLocalWallets();
  writeLocalWallets([entry, ...local.filter((w) => w.address !== wallet.address)]);

  if (!userId) return entry; // no session yet — local-only until they sign in

  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("smart_money_wallets")
      .insert({ user_id: userId, address: wallet.address, label: wallet.label, tier: wallet.tier })
      .select("id, address, label, tier, user_id")
      .single();
    if (error) throw error;
    return { id: data.id, address: data.address, label: data.label, tier: data.tier, userId: data.user_id };
  } catch {
    return entry; // synced later, or stays local-only — either way the add itself doesn't fail on the caller
  }
}

export async function removeSmartMoneyWallet(id: string | null, address: string) {
  writeLocalWallets(readLocalWallets().filter((w) => w.address !== address));
  if (!id) return;
  try {
    const supabase = getSupabaseBrowserClient();
    await supabase.from("smart_money_wallets").delete().eq("id", id);
  } catch {
    /* local removal already happened; remote cleanup can lag without blocking the UI */
  }
}

/** Seeds one curated (global, user_id NULL) wallet. Intentionally not
 * called from anywhere in the UI — this is the function your team wires
 * up to an internal admin action once you have addresses you've actually
 * verified, not something to call with placeholder data. */
export async function seedCuratedWallet(wallet: { address: string; label: string; tier: WalletTier }) {
  const supabase = getSupabaseBrowserClient();
  const { error } = await supabase
    .from("smart_money_wallets")
    .insert({ user_id: null, address: wallet.address, label: wallet.label, tier: wallet.tier });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Filter preferences: localStorage always, best-effort Supabase sync   */
/* to user_preferences.smart_money_config when signed in.               */
/* ------------------------------------------------------------------ */

export interface SmartMoneyPrefs {
  mode: "all" | "smart_only";
  tiers: WalletTier[];
}

const PREFS_LOCAL_KEY = "lx_smart_money_prefs_v1";
export const DEFAULT_SMART_MONEY_PREFS: SmartMoneyPrefs = { mode: "all", tiers: ["kol", "smart_money", "whale"] };

export function getSmartMoneyPrefs(): SmartMoneyPrefs {
  if (typeof window === "undefined") return DEFAULT_SMART_MONEY_PREFS;
  try {
    const raw = window.localStorage.getItem(PREFS_LOCAL_KEY);
    return raw ? { ...DEFAULT_SMART_MONEY_PREFS, ...JSON.parse(raw) } : DEFAULT_SMART_MONEY_PREFS;
  } catch {
    return DEFAULT_SMART_MONEY_PREFS;
  }
}

export async function saveSmartMoneyPrefs(userId: string | null, prefs: SmartMoneyPrefs) {
  if (typeof window !== "undefined") window.localStorage.setItem(PREFS_LOCAL_KEY, JSON.stringify(prefs));
  if (!userId) return;
  try {
    const supabase = getSupabaseBrowserClient();
    await supabase.from("user_preferences").upsert({ user_id: userId, smart_money_config: prefs, updated_at: new Date().toISOString() });
  } catch {
    /* local save already happened; cross-device sync can lag without blocking the UI */
  }
}

/* ------------------------------------------------------------------ */
/* Cached win-rate lookups (see app/api/v1/smart-money/winrate)         */
/* ------------------------------------------------------------------ */

const winRateCache = new Map<string, Promise<WalletWinRateStat | null>>();

/** Module-level de-duped by address, so ten alert cards for the same
 * wallet in one feed only trigger one fetch. */
export function fetchWalletWinRate(address: string): Promise<WalletWinRateStat | null> {
  const existing = winRateCache.get(address);
  if (existing) return existing;

  const promise = fetch(`/api/v1/smart-money/winrate?wallet=${address}`)
    .then((res) => res.json())
    .then((body) => (body.ok ? (body.stat as WalletWinRateStat) : null))
    .catch(() => null);

  winRateCache.set(address, promise);
  return promise;
}
