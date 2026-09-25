import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";

/**
 * Holder Distribution & Bundle Analysis — top-holder fetch + heuristic
 * insider/sniper/cluster tagging, in the same spirit as GMGN's "Top 10 /
 * Insiders / Bundle" panel.
 *
 * Everything here is READ-ONLY public RPC data (getTokenLargestAccounts,
 * getParsedAccountInfo, getSignaturesForAddress, getParsedTransaction) —
 * no custody, no writes, no third-party paid API. The tradeoff is that a
 * free public RPC rate-limits hard on the signature/transaction lookups
 * this needs, so `classifyHolders` is concurrency-limited and only walks
 * a shallow signature history per wallet (see `traceFunder`) rather than
 * a full genesis-to-now trace, the same shallow-but-useful approach
 * lib/wallet-pnl.ts takes for realized PnL.
 *
 * NOTE: this sandbox has no network access, so this hasn't been
 * exercised against a live RPC endpoint. The parsed-instruction shapes
 * below follow Solana's documented `jsonParsed` transaction encoding —
 * verify against a real endpoint (a Helius/Triton key, not public
 * mainnet-beta, or the funder trace will get rate-limited into "unknown"
 * for most wallets) before relying on the sniper/cluster tags.
 */

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Solana's de facto burn address — tokens sent here are unrecoverable.
// Some teams also just leave burned tokens in a token account with a
// revoked mint authority rather than sending here; that pattern isn't
// detectable from holder data alone, so `burnedPct` only reflects this.
const INCINERATOR_ADDRESS = "1nc1nerator11111111111111111111111111111111";

// Program-derived authorities that commonly custody LP-side token
// accounts. Treating a holder as "DEX/Pool" rather than "Insider" when
// its owner matches one of these avoids flagging a token's own Raydium
// liquidity as an insider wallet. This list is necessarily incomplete —
// extend it as new AMMs/launchpads show up in practice, and verify these
// specific addresses against a live endpoint before trusting the tag.
const KNOWN_POOL_AUTHORITIES = new Set<string>([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
  "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnzPQL4t4wc", // Raydium CPMM authority
]);

const SNIPER_WINDOW_MS = 45_000; // "bought within 45s of mint" == sniper, tune as needed

export type HolderTag = "dev" | "insider" | "sniper" | "dex_pool" | "burned" | "unknown";

export interface HolderInfo {
  tokenAccount: string;
  owner: string;
  uiAmount: number;
  pctOfSupply: number;
  tag: HolderTag;
  fundedBy: string | null;
  firstSeenMs: number | null;
  clusterId: string | null;
}

export interface InsiderCluster {
  id: string;
  funder: string;
  members: string[];
  pctOfSupply: number;
}

export interface HolderAnalysis {
  mint: string;
  fetchedAt: number;
  totalSupplyUi: number;
  top10Pct: number;
  devPct: number;
  burnedPct: number;
  dexPoolPct: number;
  insiderPct: number; // dev + clustered insiders + snipers, i.e. everything NOT free float
  freeFloatPct: number;
  sniperCount: number;
  clusters: InsiderCluster[];
  holders: HolderInfo[];
  partial: boolean; // true if funder-tracing was skipped/truncated (rate limit, no devWallet, etc.)
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Top N holders (by raw amount, RPC's own sort order) for a mint, with
 * each token account resolved to its owning wallet. `getTokenLargestAccounts`
 * caps out at 20 accounts — that's the practical ceiling for this kind of
 * panel anyway (GMGN's own "Top 10" only needs the first 10 of these). */
export async function fetchTopHolders(
  connection: Connection,
  mint: string,
  limit = 20
): Promise<{ holders: HolderInfo[]; totalSupplyUi: number }> {
  const mintPubkey = new PublicKey(mint);

  const [largest, supply] = await Promise.all([
    connection.getTokenLargestAccounts(mintPubkey),
    connection.getTokenSupply(mintPubkey),
  ]);

  const totalSupplyUi = supply.value.uiAmount ?? 0;
  const accounts = largest.value.slice(0, limit);
  if (accounts.length === 0 || totalSupplyUi === 0) {
    return { holders: [], totalSupplyUi };
  }

  // Resolve each largest token account -> its owning wallet in one batched
  // call rather than N round trips.
  const infos = await connection.getMultipleParsedAccounts(accounts.map((a) => a.address));

  const holders: HolderInfo[] = accounts.map((a, i) => {
    const parsed = infos.value[i]?.data as ParsedAccountData | undefined;
    const owner: string = parsed?.parsed?.info?.owner ?? "unknown";
    const uiAmount = a.uiAmount ?? 0;
    const pctOfSupply = round2((uiAmount / totalSupplyUi) * 100);

    let tag: HolderTag = "unknown";
    if (owner === INCINERATOR_ADDRESS) tag = "burned";
    else if (KNOWN_POOL_AUTHORITIES.has(owner)) tag = "dex_pool";

    return {
      tokenAccount: a.address.toBase58(),
      owner,
      uiAmount,
      pctOfSupply,
      tag,
      fundedBy: null,
      firstSeenMs: null,
      clusterId: null,
    };
  });

  return { holders, totalSupplyUi };
}

/** Walks a wallet's earliest available signatures (oldest page this RPC
 * will hand back in one call — a full genesis trace would mean paging
 * `before` all the way back, which a free RPC won't tolerate for a UI
 * that has to do this for ~15 wallets per token view) and looks for the
 * first native-SOL transfer INTO the wallet. That source is treated as
 * "who funded this wallet" — the same signal a manual bundle-checker
 * uses when they open a wallet on Solscan and scroll to the bottom. */
async function traceFunder(
  connection: Connection,
  owner: string
): Promise<{ funder: string | null; firstSeenMs: number | null }> {
  try {
    const ownerPubkey = new PublicKey(owner);
    // Oldest-first within a single page: ask for a modest batch and take
    // the tail, rather than paginating `before` repeatedly.
    const sigs = await connection.getSignaturesForAddress(ownerPubkey, { limit: 25 });
    if (sigs.length === 0) return { funder: null, firstSeenMs: null };

    const oldest = sigs[sigs.length - 1];
    const tx = await connection.getParsedTransaction(oldest.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return { funder: null, firstSeenMs: oldest.blockTime ? oldest.blockTime * 1000 : null };

    const firstSeenMs = tx.blockTime ? tx.blockTime * 1000 : oldest.blockTime ? oldest.blockTime * 1000 : null;

    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      const parsed: any = (ix as any).parsed;
      if (
        parsed?.type === "transfer" &&
        parsed?.info?.destination === owner &&
        typeof parsed?.info?.lamports === "number"
      ) {
        return { funder: parsed.info.source as string, firstSeenMs };
      }
    }
    return { funder: null, firstSeenMs };
  } catch {
    // Rate-limited, unparseable, or the wallet has no history yet — all
    // of these degrade to "unknown funder" rather than throwing, same
    // defensive pattern as lib/rugcheck.ts's batch fetch.
    return { funder: null, firstSeenMs: null };
  }
}

/** Concurrency-limited funder trace across the top holders, then groups
 * wallets that share a funder into clusters and tags dev/insider/sniper.
 * `devWallet` and `tokenCreatedAtMs` are both optional — pass what the
 * caller already has (e.g. PumpPortal's `creator` + `createdAt` for a
 * pump.fun mint) since neither is derivable from holder data alone. */
export async function classifyHolders(
  connection: Connection,
  holders: HolderInfo[],
  opts: { devWallet?: string; tokenCreatedAtMs?: number; concurrency?: number } = {}
): Promise<{ holders: HolderInfo[]; clusters: InsiderCluster[]; partial: boolean }> {
  const { devWallet, tokenCreatedAtMs, concurrency = 4 } = opts;

  const traceable = holders.filter((h) => h.tag === "unknown");
  const results = new Map<string, { funder: string | null; firstSeenMs: number | null }>();

  let partial = false;
  if (traceable.length > 0) {
    let idx = 0;
    async function worker() {
      while (idx < traceable.length) {
        const h = traceable[idx++];
        const r = await traceFunder(connection, h.owner);
        if (!r.funder && !r.firstSeenMs) partial = true;
        results.set(h.owner, r);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, traceable.length) }, worker));
  }

  // Group by funder (excluding null funders, which can't be clustered).
  const byFunder = new Map<string, HolderInfo[]>();
  const updated = holders.map((h) => {
    if (h.tag !== "unknown") return h;
    const trace = results.get(h.owner);
    const fundedBy = trace?.funder ?? null;
    const firstSeenMs = trace?.firstSeenMs ?? null;

    let tag: HolderTag = "unknown";
    if (devWallet && h.owner === devWallet) tag = "dev";
    else if (devWallet && fundedBy === devWallet) tag = "insider";
    else if (
      tokenCreatedAtMs != null &&
      firstSeenMs != null &&
      firstSeenMs - tokenCreatedAtMs >= 0 &&
      firstSeenMs - tokenCreatedAtMs <= SNIPER_WINDOW_MS
    ) {
      tag = "sniper";
    }

    const next: HolderInfo = { ...h, tag, fundedBy, firstSeenMs };
    if (fundedBy && tag !== "dev") {
      const bucket = byFunder.get(fundedBy) ?? [];
      bucket.push(next);
      byFunder.set(fundedBy, bucket);
    }
    return next;
  });

  const clusters: InsiderCluster[] = [];
  for (const [funder, members] of byFunder.entries()) {
    if (members.length < 2) continue; // a single wallet with a unique funder isn't a "cluster"
    const clusterId = `cluster-${funder.slice(0, 8)}`;
    for (const m of members) {
      m.clusterId = clusterId;
      if (m.tag === "unknown") m.tag = "insider"; // 2+ top holders funded by the same non-dev wallet
    }
    clusters.push({
      id: clusterId,
      funder,
      members: members.map((m) => m.owner),
      pctOfSupply: round2(members.reduce((s, m) => s + m.pctOfSupply, 0)),
    });
  }

  return { holders: updated, clusters, partial };
}

export interface FetchHolderAnalysisOpts {
  limit?: number;
  devWallet?: string;
  tokenCreatedAtMs?: number;
  concurrency?: number;
  /** Skip the funder trace entirely and return supply-breakdown metrics
   * only (top10/dev/burned/pool%) — much cheaper, useful for a card in a
   * list where the full trace only needs to run once the user opens the
   * detail panel. */
  skipClusterTrace?: boolean;
}

/** Main entry point: fetch top holders for a mint and classify them.
 * Combines `fetchTopHolders` + `classifyHolders` and rolls the result up
 * into the aggregate percentages the UI panel needs. */
export async function fetchHolderAnalysis(
  connection: Connection,
  mint: string,
  opts: FetchHolderAnalysisOpts = {}
): Promise<HolderAnalysis> {
  const { limit = 20, devWallet, tokenCreatedAtMs, concurrency, skipClusterTrace } = opts;

  const { holders: rawHolders, totalSupplyUi } = await fetchTopHolders(connection, mint, limit);

  let holders = rawHolders;
  let clusters: InsiderCluster[] = [];
  let partial = skipClusterTrace ?? false;

  if (!skipClusterTrace && holders.length > 0) {
    const classified = await classifyHolders(connection, holders, { devWallet, tokenCreatedAtMs, concurrency });
    holders = classified.holders;
    clusters = classified.clusters;
    partial = classified.partial;
  } else if (devWallet) {
    // Even in the cheap path, tag the dev wallet directly if we already
    // know its address — no tracing required for that one.
    holders = holders.map((h) => (h.owner === devWallet ? { ...h, tag: "dev" as HolderTag } : h));
  }

  const top10Pct = round2(holders.slice(0, 10).reduce((s, h) => s + h.pctOfSupply, 0));
  const devPct = round2(holders.filter((h) => h.tag === "dev").reduce((s, h) => s + h.pctOfSupply, 0));
  const burnedPct = round2(holders.filter((h) => h.tag === "burned").reduce((s, h) => s + h.pctOfSupply, 0));
  const dexPoolPct = round2(holders.filter((h) => h.tag === "dex_pool").reduce((s, h) => s + h.pctOfSupply, 0));
  const sniperPct = round2(holders.filter((h) => h.tag === "sniper").reduce((s, h) => s + h.pctOfSupply, 0));
  const clusterPct = round2(clusters.reduce((s, c) => s + c.pctOfSupply, 0));
  const sniperCount = holders.filter((h) => h.tag === "sniper").length;

  const insiderPct = round2(devPct + clusterPct + sniperPct);
  const freeFloatPct = round2(Math.max(0, 100 - insiderPct - burnedPct - dexPoolPct));

  return {
    mint,
    fetchedAt: Date.now(),
    totalSupplyUi,
    top10Pct,
    devPct,
    burnedPct,
    dexPoolPct,
    insiderPct,
    freeFloatPct,
    sniperCount,
    clusters,
    holders,
    partial,
  };
}

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
