import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";

/**
 * Realized PnL computed entirely from RPC data the wallet's own history
 * already contains — no indexer, no paid service. The tradeoff: public
 * RPC endpoints are rate-limited (often ~1 req/sec, sometimes less), and
 * `getParsedTransaction` is one call per signature, so this is slow and
 * will 429 on a heavily-traded wallet against the default public
 * mainnet-beta endpoint. A free-tier RPC key (Helius/QuickNode/Triton all
 * have generous free tiers) via NEXT_PUBLIC_SOLANA_RPC_URL fixes that —
 * it's still $0, just needs a 30-second signup.
 */

export interface RealizedTrade {
  signature: string;
  timestamp: number;
  mint: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number; // SOL spent (buy) or received (sell), net of fees
}

export interface RealizedPnlSummary {
  trades: RealizedTrade[];
  byMint: Record<string, { realizedSol: number; buys: number; sells: number }>;
  totalRealizedSol: number;
  winRatePct: number; // % of closed (sell) trades with positive realized PnL on that mint at that point
  scannedSignatures: number;
  truncated: boolean; // true if we stopped before the full history due to `maxSignatures`
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Pulls the wallet's recent parsed transactions and extracts SPL token
 * balance deltas to reconstruct a buy/sell trade log. */
async function extractTrades(
  connection: Connection,
  owner: string,
  maxSignatures: number,
  onProgress?: (done: number, total: number) => void
): Promise<{ trades: RealizedTrade[]; scanned: number; truncated: boolean }> {
  const ownerKey = new PublicKey(owner);
  const sigInfos = await connection.getSignaturesForAddress(ownerKey, { limit: maxSignatures });
  const trades: RealizedTrade[] = [];

  for (let i = 0; i < sigInfos.length; i++) {
    onProgress?.(i, sigInfos.length);
    const sigInfo = sigInfos[i];
    if (sigInfo.err) continue; // skip failed txs

    let tx: ParsedTransactionWithMeta | null = null;
    try {
      tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
    } catch {
      continue; // rate-limited or unparsable — skip rather than abort the whole scan
    }
    if (!tx?.meta) continue;

const preTokenBalances = tx.meta.preTokenBalances ?? [];
const postTokenBalances = tx.meta.postTokenBalances ?? [];
const { preBalances, postBalances } = tx.meta;
    const accountKeys = tx.transaction.message.accountKeys;
    const ownerIndex = accountKeys.findIndex((k) => k.pubkey.toBase58() === owner);
    const solDeltaLamports = ownerIndex >= 0 ? (postBalances[ownerIndex] ?? 0) - (preBalances[ownerIndex] ?? 0) : 0;
    const solDelta = solDeltaLamports / LAMPORTS_PER_SOL;

    // Build pre/post maps of this owner's token balances by mint.
    const pre: Record<string, number> = {};
    const post: Record<string, number> = {};
    for (const b of preTokenBalances) {
      if (b.owner === owner) pre[b.mint] = b.uiTokenAmount.uiAmount ?? 0;
    }
    for (const b of postTokenBalances) {
      if (b.owner === owner) post[b.mint] = b.uiTokenAmount.uiAmount ?? 0;
    }

    const mints = new Set([...Object.keys(pre), ...Object.keys(post)]);
    for (const mint of mints) {
      if (mint === SOL_MINT) continue; // handled via native SOL delta instead
      const delta = (post[mint] ?? 0) - (pre[mint] ?? 0);
      if (Math.abs(delta) < 1e-9) continue;

      // A swap tx that moves this token also moves the owner's native SOL
      // the other way — use that as this leg's SOL amount. Multi-hop
      // routes (e.g. token A -> SOL -> token B in one tx) will misattribute
      // some of the SOL delta; treat this as an approximation, not audit-grade.
      trades.push({
        signature: sigInfo.signature,
        timestamp: (sigInfo.blockTime ?? 0) * 1000,
        mint,
        side: delta > 0 ? "buy" : "sell",
        tokenAmount: Math.abs(delta),
        solAmount: Math.abs(solDelta),
      });
    }
  }

  return { trades, scanned: sigInfos.length, truncated: sigInfos.length === maxSignatures };
}

/** FIFO cost-basis matching per mint, in SOL terms. */
function computeRealizedPnl(trades: RealizedTrade[]): RealizedPnlSummary {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const lots: Record<string, { tokenAmount: number; solAmount: number }[]> = {};
  const byMint: Record<string, { realizedSol: number; buys: number; sells: number }> = {};
  let wins = 0;
  let closedSells = 0;

  for (const t of sorted) {
    byMint[t.mint] = byMint[t.mint] || { realizedSol: 0, buys: 0, sells: 0 };
    lots[t.mint] = lots[t.mint] || [];

    if (t.side === "buy") {
      lots[t.mint].push({ tokenAmount: t.tokenAmount, solAmount: t.solAmount });
      byMint[t.mint].buys++;
    } else {
      byMint[t.mint].sells++;
      let remaining = t.tokenAmount;
      let realizedThisTrade = 0;

      while (remaining > 1e-9 && lots[t.mint].length > 0) {
        const lot = lots[t.mint][0];
        const matched = Math.min(lot.tokenAmount, remaining);
        const lotCostShare = (matched / lot.tokenAmount) * lot.solAmount;
        const proceedsShare = (matched / t.tokenAmount) * t.solAmount;

        realizedThisTrade += proceedsShare - lotCostShare;

        lot.tokenAmount -= matched;
        lot.solAmount -= lotCostShare;
        remaining -= matched;
        if (lot.tokenAmount <= 1e-9) lots[t.mint].shift();
      }

      byMint[t.mint].realizedSol += realizedThisTrade;
      closedSells++;
      if (realizedThisTrade > 0) wins++;
    }
  }

  const totalRealizedSol = Object.values(byMint).reduce((s, v) => s + v.realizedSol, 0);

  return {
    trades: sorted,
    byMint,
    totalRealizedSol,
    winRatePct: closedSells > 0 ? (wins / closedSells) * 100 : 0,
    scannedSignatures: 0, // filled in by caller
    truncated: false, // filled in by caller
  };
}

export async function fetchRealizedPnl(
  connection: Connection,
  owner: string,
  maxSignatures = 200,
  onProgress?: (done: number, total: number) => void
): Promise<RealizedPnlSummary> {
  const { trades, scanned, truncated } = await extractTrades(connection, owner, maxSignatures, onProgress);
  const summary = computeRealizedPnl(trades);
  return { ...summary, scannedSignatures: scanned, truncated };
}
