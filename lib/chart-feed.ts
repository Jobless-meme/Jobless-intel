/**
 * Live chart data — GeckoTerminal public API (keyless, ~30 req/min).
 * Docs: https://apiguide.geckoterminal.com
 *
 * GeckoTerminal indexes on-chain pools, not raw token pairs, so resolving
 * a chart for a token means: find its most liquid pool on the network,
 * then pull OHLCV candles for that pool.
 */

const GT_BASE = "https://api.geckoterminal.com/api/v2";

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type ChartNetwork = "solana" | "bsc";

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const TIMEFRAME_MAP: Record<Timeframe, { unit: "minute" | "hour" | "day"; aggregate: number }> = {
  "1m": { unit: "minute", aggregate: 1 },
  "5m": { unit: "minute", aggregate: 5 },
  "15m": { unit: "minute", aggregate: 15 },
  "1h": { unit: "hour", aggregate: 1 },
  "4h": { unit: "hour", aggregate: 4 },
  "1d": { unit: "day", aggregate: 1 },
};

async function gtFetch(path: string) {
  const res = await fetch(`${GT_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    if (res.status === 429) throw new Error("Rate limited by GeckoTerminal — back off and retry");
    throw new Error(`GeckoTerminal ${path} failed: ${res.status}`);
  }
  return res.json();
}

/** Find the most liquid pool for a token so we have something to chart. */
export async function resolvePool(
  network: ChartNetwork,
  tokenAddress: string
): Promise<{
  poolAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
} | null> {
  const data = await gtFetch(`/networks/${network}/tokens/${tokenAddress}/pools?page=1`);
  const pools = data?.data as any[] | undefined;
  if (!pools || pools.length === 0) return null;

  const best = [...pools].sort(
    (a, b) => Number(b.attributes.reserve_in_usd ?? 0) - Number(a.attributes.reserve_in_usd ?? 0)
  )[0];

  const [baseSymbol, quoteSymbol] = String(best.attributes.name ?? "? / ?").split(" / ");
  return {
    poolAddress: best.attributes.address,
    baseSymbol: baseSymbol?.trim() ?? "?",
    quoteSymbol: quoteSymbol?.trim() ?? "?",
    priceUsd: Number(best.attributes.base_token_price_usd ?? 0),
    liquidityUsd: Number(best.attributes.reserve_in_usd ?? 0),
    volume24hUsd: Number(best.attributes.volume_usd?.h24 ?? 0),
  };
}

/** Pull OHLCV candles for a known pool address. */
export async function fetchOhlcv(
  network: ChartNetwork,
  poolAddress: string,
  timeframe: Timeframe = "1h",
  limit = 48
): Promise<Candle[]> {
  const { unit, aggregate } = TIMEFRAME_MAP[timeframe];
  const data = await gtFetch(
    `/networks/${network}/pools/${poolAddress}/ohlcv/${unit}?aggregate=${aggregate}&limit=${limit}`
  );
  const list = data?.data?.attributes?.ohlcv_list as number[][] | undefined;
  if (!list) return [];

  // API returns newest-first as [timestamp, open, high, low, close, volume]
  return list
    .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    .sort((a, b) => a.time - b.time);
}

/** Convenience: token address -> live candles + current pair label, in one call. */
export async function fetchLiveChart(network: ChartNetwork, tokenAddress: string, timeframe: Timeframe = "1h") {
  const pool = await resolvePool(network, tokenAddress);
  if (!pool) throw new Error("No liquid pool found for this token yet");
  const candles = await fetchOhlcv(network, pool.poolAddress, timeframe);
  return { pool, candles };
}
