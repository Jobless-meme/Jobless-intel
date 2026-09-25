/**
 * Mint → ticker lookup for card/list labels. DexScreener's token endpoint
 * takes up to 30 comma-separated mints per call and is already the
 * fallback price source in lib/tpsl-engine.ts. Best-effort: a mint it
 * doesn't know just renders as its shortened address.
 *
 * Symbols are third-party, attacker-controlled text — sanitise before
 * drawing them (lib/pnl-card-renderer.ts sanitizeSymbol).
 */

const DEXSCREENER_TOKENS = "https://api.dexscreener.com/latest/dex/tokens";
const cache = new Map<string, string>();

export async function fetchTokenSymbols(mints: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const m of Array.from(new Set(mints))) {
    const hit = cache.get(m);
    if (hit) out[m] = hit;
    else missing.push(m);
  }

  for (let i = 0; i < missing.length; i += 30) {
    const batch = missing.slice(i, i + 30);
    try {
      const res = await fetch(`${DEXSCREENER_TOKENS}/${batch.join(",")}`, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const pair of (data?.pairs ?? []) as any[]) {
        const addr = pair?.baseToken?.address;
        const symbol = pair?.baseToken?.symbol;
        if (addr && symbol && batch.includes(addr) && !out[addr]) {
          out[addr] = String(symbol);
          cache.set(addr, String(symbol));
        }
      }
    } catch {
      /* leave this batch unresolved — labels fall back to the short mint */
    }
  }
  return out;
}
