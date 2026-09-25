import type { ChartNetwork } from "./chart-feed";

const GT_BASE = "https://api.geckoterminal.com/api/v2";

/** GeckoTerminal's simple/token_price endpoint accepts up to 30 addresses per call. */
export async function fetchTokenPricesUsd(
  network: ChartNetwork,
  addresses: string[]
): Promise<Record<string, number>> {
  if (addresses.length === 0) return {};
  const prices: Record<string, number> = {};

  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const res = await fetch(`${GT_BASE}/simple/networks/${network}/token_price/${batch.join(",")}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) continue; // skip a failed batch rather than fail the whole lookup
    const data = await res.json();
    const tokenPrices = data?.data?.attributes?.token_prices as Record<string, string> | undefined;
    if (tokenPrices) {
      for (const [addr, price] of Object.entries(tokenPrices)) {
        prices[addr.toLowerCase()] = Number(price);
      }
    }
  }

  return prices;
}
