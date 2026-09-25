import type { ChartNetwork } from "./chart-feed";

const GT_BASE = "https://api.geckoterminal.com/api/v2";

export interface TrendingToken {
  network: ChartNetwork;
  tokenAddress: string; // base token's contract/mint address, for the chart + swaps
  name: string;
  symbol: string;
  priceUsd: number;
  change24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

async function gtFetch(path: string) {
  const res = await fetch(`${GT_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal ${path} failed: ${res.status}`);
  return res.json();
}

/** Top trending pools on one network, mapped down to their base token. */
async function trendingForNetwork(network: ChartNetwork, limit = 10): Promise<TrendingToken[]> {
  const data = await gtFetch(`/networks/${network}/trending_pools?page=1`);
  const pools = (data?.data as any[] | undefined) ?? [];
  const included = (data?.included as any[] | undefined) ?? [];

  return pools.slice(0, limit).map((pool) => {
    const attrs = pool.attributes;
    const baseTokenId = pool.relationships?.base_token?.data?.id as string | undefined;
    const baseToken = included.find((i) => i.id === baseTokenId);
    const tokenAddress: string = baseToken?.attributes?.address ?? attrs.address;
    const [baseSymbol] = String(attrs.name ?? "? / ?").split(" / ");

    return {
      network,
      tokenAddress,
      name: baseToken?.attributes?.name ?? baseSymbol?.trim() ?? "Unknown",
      symbol: baseToken?.attributes?.symbol ?? baseSymbol?.trim() ?? "?",
      priceUsd: Number(attrs.base_token_price_usd ?? 0),
      change24h: Number(attrs.price_change_percentage?.h24 ?? 0),
      volume24hUsd: Number(attrs.volume_usd?.h24 ?? 0),
      liquidityUsd: Number(attrs.reserve_in_usd ?? 0),
    };
  });
}

/** Trending tokens across both supported chains, merged and sorted by 24h volume. */
export async function fetchTrendingFeed(limit = 10): Promise<TrendingToken[]> {
  const [sol, bsc] = await Promise.allSettled([trendingForNetwork("solana", limit), trendingForNetwork("bsc", limit)]);

  const merged = [
    ...(sol.status === "fulfilled" ? sol.value : []),
    ...(bsc.status === "fulfilled" ? bsc.value : []),
  ];

  return merged.sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, limit);
}
