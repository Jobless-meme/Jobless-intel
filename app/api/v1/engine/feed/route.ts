import { NextRequest, NextResponse } from "next/server";

/**
 * Execution Bay — unified engine router.
 *
 * Architecture note: everything here is NON-CUSTODIAL. This route builds
 * quotes, unsigned transactions, and on-chain order payloads; it never
 * holds or uses a private key. The connected wallet (client side) is what
 * actually signs and broadcasts. "Automated" triggers (limit / TP / SL /
 * trailing / DCA) are implemented via Jupiter's real on-chain Trigger and
 * Recurring programs, which are executed by permissionless keepers once
 * the user's order account is created and funded — not by a server-side
 * bot holding user funds. If you later want a fully unattended custodial
 * executor, that's a distinct, much higher-risk system (key management,
 * custody, audits) and is intentionally out of scope here.
 */

const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP = "https://api.jup.ag/swap/v1/swap";
const JUP_TRIGGER = "https://api.jup.ag/trigger/v1";
const JUP_RECURRING = "https://api.jup.ag/recurring/v1";
const ZEROX_QUOTE = "https://api.0x.org/swap/permit2/quote";
const ZEROX_PRICE = "https://api.0x.org/swap/permit2/price";
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

function fee() {
  return {
    jupiterFeeBps: 50,
    jupiterFeeAccount: process.env.MY_JUPITER_REFERRAL_FEE_ACCOUNT || null,
    bscFeeBps: 50,
    bscFeeRecipient: process.env.MY_BSC_FEE_RECIPIENT_ADDRESS || null,
  };
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return bad("Malformed JSON body");
  }
  const { tool, params } = body || {};
  if (!tool) return bad("Missing `tool`");

  try {
    switch (tool) {
      case "execute-swap-order":
        return NextResponse.json(await executeSwapOrder(params));
      case "jupiter-quote":
        return NextResponse.json(await jupiterQuoteTool(params));
      case "multi-wallet-batch":
        return NextResponse.json(await multiWalletBatch(params));
      case "priority-gas-booster":
        return NextResponse.json(await priorityGasBooster(params));
      case "jito-mev-bundle-shield":
        return NextResponse.json(await jitoMevBundleShield(params));
      case "limit-order-scheduler":
        return NextResponse.json(await limitOrderScheduler(params));
      case "take-profit-trigger":
        return NextResponse.json(await takeProfitTrigger(params));
      case "stop-loss-guard":
        return NextResponse.json(await stopLossGuard(params));
      case "trailing-stop-loss-engine":
        return NextResponse.json(await trailingStopLossEngine(params));
      case "dca-dollar-cost-averaging-scheduler":
        return NextResponse.json(await dcaScheduler(params));
      case "mev-sandwich-protection":
        return NextResponse.json(await mevSandwichProtection(params));
      case "sandwich-bot-exploit-revenue-share":
        return NextResponse.json(await sandwichShieldTelemetry(params));
      case "slippage-auto-optimizer":
        return NextResponse.json(await slippageAutoOptimizer(params));
      case "robinhood-connect-fiat-onramp":
        return NextResponse.json(await fiatOnramp(params));
      case "wallet-pnl-realized-analytics":
        return NextResponse.json(await realizedPnl(params));
      case "wallet-unrealized-valuation":
        return NextResponse.json(await unrealizedValuation(params));
      default:
        return bad(`Unknown tool: ${tool}`, 404);
    }
  } catch (err: any) {
    return bad(err?.message || "Engine error", 500);
  }
}

const MAX_PRIORITY_FEE_LAMPORTS = 5_000_000; // 0.005 SOL hard ceiling per tx

/** Shared Jupiter quote call. Always carries platformFeeBps so the quote a
 * client previews is priced the same as the one execute-swap-order builds. */
async function fetchJupiterQuote(q: {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  slippageBps?: number;
}) {
  const { jupiterFeeBps } = fee();
  const url = new URL(JUP_QUOTE);
  url.searchParams.set("inputMint", q.inputMint);
  url.searchParams.set("outputMint", q.outputMint);
  url.searchParams.set("amount", String(q.amount));
  url.searchParams.set("slippageBps", String(q.slippageBps ?? 50));
  url.searchParams.set("platformFeeBps", String(jupiterFeeBps));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Jupiter quote failed: ${res.status}${detail ? ` — ${detail.slice(0, 160)}` : ""}`);
  }
  return res.json();
}

/** Quote-only tool: no transaction is built. Used for batch pre-flight
 * (price-impact guard + expected output preview). */
async function jupiterQuoteTool(p: any) {
  const { inputMint, outputMint, amount, slippageBps } = p || {};
  if (!inputMint || !outputMint || !amount) {
    throw new Error("jupiter-quote requires inputMint, outputMint, amount");
  }
  const quote = await fetchJupiterQuote({ inputMint, outputMint, amount, slippageBps });
  return { ok: true, quote };
}

/* ------------------------------------------------------------------ */
/* 1. execute-swap-order                                              */
/* ------------------------------------------------------------------ */
async function executeSwapOrder(p: any) {
  const { chain, inputMint, outputMint, amount, userPublicKey, slippageBps } = p || {};
  // Optional fixed priority fee (total lamports) — used by the batch engine.
  // Clamped server-side so a bad client value can never burn a wallet on fees.
  const priorityFeeLamports = Math.min(
    Math.max(Math.floor(Number(p?.priorityFeeLamports) || 0), 0),
    MAX_PRIORITY_FEE_LAMPORTS
  );
  if (!chain || !inputMint || !outputMint || !amount || !userPublicKey) {
    throw new Error("execute-swap-order requires chain, inputMint, outputMint, amount, userPublicKey");
  }

  if (chain === "solana") {
    const { jupiterFeeBps, jupiterFeeAccount } = fee();
    const quote = await fetchJupiterQuote({ inputMint, outputMint, amount, slippageBps });

    if (!jupiterFeeAccount) {
      // Fee account must exist on-chain for the (inputMint, referral) pair
      // before it can be passed to /swap, otherwise Jupiter will reject
      // the build. We still return the quote so the UI can show pricing.
      return {
        ok: true,
        chain,
        quote,
        swapTransaction: null,
        warning:
          "MY_JUPITER_REFERRAL_FEE_ACCOUNT is not set — quote returned, but no fee-bearing swap transaction was built.",
      };
    }

    const swapRes = await fetch(JUP_SWAP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        feeAccount: jupiterFeeAccount,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        ...(priorityFeeLamports > 0 ? { prioritizationFeeLamports: priorityFeeLamports } : {}),
      }),
    });
    if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status}`);
    const swap = await swapRes.json();

    return {
      ok: true,
      chain,
      quote,
      swapTransaction: swap.swapTransaction, // base64 unsigned tx — sign client-side
      lastValidBlockHeight: swap.lastValidBlockHeight,
      feeBps: jupiterFeeBps,
      note: "Unsigned transaction. Sign & send with the connected wallet adapter.",
    };
  }

  if (chain === "bsc") {
    const { bscFeeBps, bscFeeRecipient } = fee();
    if (!process.env.ZEROX_API_KEY) {
      throw new Error("ZEROX_API_KEY not configured for BSC routing");
    }
    const url = new URL(ZEROX_QUOTE);
    url.searchParams.set("chainId", "56");
    url.searchParams.set("sellToken", inputMint);
    url.searchParams.set("buyToken", outputMint);
    url.searchParams.set("sellAmount", String(amount));
    url.searchParams.set("taker", userPublicKey);
    url.searchParams.set("swapFeeBps", String(bscFeeBps));
    if (bscFeeRecipient) url.searchParams.set("swapFeeRecipient", bscFeeRecipient);
    url.searchParams.set("swapFeeToken", outputMint);

    const res = await fetch(url.toString(), {
      headers: {
        "0x-api-key": process.env.ZEROX_API_KEY,
        "0x-version": "v2",
      },
    });
    if (!res.ok) throw new Error(`0x quote failed: ${res.status}`);
    const data = await res.json();

    return {
      ok: true,
      chain,
      quote: data,
      unsignedTx: data, // full 0x quote: {transaction, permit2, issues, ...} — see lib/permit2.ts client-side
      feeBps: bscFeeBps,
      note: "Permit2 flow: client must check quote.issues.allowance, sign quote.permit2.eip712, then splice the signature into transaction.data before sending. See lib/permit2.ts.",
    };
  }

  throw new Error(`Unsupported chain: ${chain}`);
}

/* ------------------------------------------------------------------ */
/* 2. multi-wallet-batch                                              */
/* ------------------------------------------------------------------ */
async function multiWalletBatch(p: any) {
  const { totalAmount, wallets, mode } = p || {};
  if (!totalAmount || !Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("multi-wallet-batch requires totalAmount and a non-empty wallets[]");
  }
  if (wallets.length > 3) throw new Error("multi-wallet-batch supports at most 3 wallets");

  const total = BigInt(totalAmount);
  let weights: number[];
  if (mode === "even" || !mode) {
    weights = wallets.map(() => 1 / wallets.length);
  } else if (mode === "weighted") {
    const sumW = wallets.reduce((s: number, w: any) => s + (w.weight ?? 1), 0);
    weights = wallets.map((w: any) => (w.weight ?? 1) / sumW);
  } else {
    throw new Error(`Unknown split mode: ${mode}`);
  }

  const allocations = [];
  let remaining = total;
  for (let i = 0; i < wallets.length; i++) {
    const isLast = i === wallets.length - 1;
    const share = isLast
      ? remaining
      : (total * BigInt(Math.round(weights[i] * 10000))) / BigInt(10000);
    remaining -= share;
    allocations.push({ address: wallets[i].address, amount: share.toString() });
  }

  return { ok: true, totalAmount: String(total), mode: mode ?? "even", allocations };
}

/* ------------------------------------------------------------------ */
/* 3. priority-gas-booster                                            */
/* ------------------------------------------------------------------ */
async function priorityGasBooster(p: any) {
  const { chain, mode } = p || {};
  const tier = mode ?? "standard";

  if (chain === "solana") {
    let base = 1000; // microLamports/CU
    try {
      const res = await fetch("https://api.jup.ag/swap/v1/priority-fee-estimate");
      if (res.ok) {
        const j = await res.json();
        base = j?.priorityFeeEstimate ?? base;
      }
    } catch {
      /* fall back to static base below */
    }
    const mult = ({ standard: 1, fast: 2.5, turbo: 6 } as Record<string, number>)[tier] ?? 1;
    return {
      ok: true,
      chain,
      mode: tier,
      microLamportsPerCU: Math.round(base * mult),
      unit: "microLamports",
    };
  }

  if (chain === "bsc") {
    let baseGwei = 1;
    try {
      const res = await fetch("https://api.0x.org/gasnow", {
        headers: process.env.ZEROX_API_KEY ? { "0x-api-key": process.env.ZEROX_API_KEY } : {},
      });
      if (res.ok) {
        const j = await res.json();
        baseGwei = j?.data?.rapid ? j.data.rapid / 1e9 : baseGwei;
      }
    } catch {
      /* fall back to static base below */
    }
    const mult = ({ standard: 1, fast: 1.5, turbo: 2.2 } as Record<string, number>)[tier] ?? 1;
    return { ok: true, chain, mode: tier, gwei: +(baseGwei * mult).toFixed(2) };
  }

  throw new Error(`Unsupported chain: ${chain}`);
}

/* ------------------------------------------------------------------ */
/* 4. jito-mev-bundle-shield                                          */
/* ------------------------------------------------------------------ */
async function jitoMevBundleShield(p: any) {
  const { tipLamports } = p || {};
  const tip = tipLamports ?? 100_000; // 0.0001 SOL default
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

  return {
    ok: true,
    tipAccount,
    tipLamports: tip,
    instruction: {
      programId: "11111111111111111111111111111111", // System Program transfer
      note: "Append a SystemProgram.transfer(userPubkey -> tipAccount, tipLamports) as the LAST instruction in the transaction before signing, then submit the whole bundle to Jito's Block Engine (block-engine.jito.wtf) instead of a public RPC.",
    },
    endpoint: "https://mainnet.block-engine.jito.wtf/api/v1/bundles",
  };
}

/* ------------------------------------------------------------------ */
/* 5–8. Trigger-based orders via Jupiter's on-chain Trigger program   */
/*    (covers limit orders, take-profit, stop-loss, trailing-stop)    */
/* ------------------------------------------------------------------ */
async function createTriggerOrder(p: any, kind: string) {
  const { inputMint, outputMint, makingAmount, takingAmount, userPublicKey, expiredAt } = p || {};
  if (!inputMint || !outputMint || !makingAmount || !takingAmount || !userPublicKey) {
    throw new Error(`${kind} requires inputMint, outputMint, makingAmount, takingAmount, userPublicKey`);
  }
  const { jupiterFeeAccount } = fee();

  const res = await fetch(`${JUP_TRIGGER}/createOrder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputMint,
      outputMint,
      maker: userPublicKey,
      payer: userPublicKey,
      params: {
        makingAmount: String(makingAmount),
        takingAmount: String(takingAmount),
        expiredAt: expiredAt ?? null,
      },
      feeAccount: jupiterFeeAccount ?? undefined,
    }),
  });
  if (!res.ok) throw new Error(`Jupiter Trigger createOrder failed: ${res.status}`);
  const data = await res.json();
  return {
    ok: true,
    kind,
    order: data,
    unsignedTx: data.tx ?? null,
    note: "Sign & send this transaction to create the on-chain order account. A permissionless keeper network fills it when price crosses your trigger — no server-side bot required.",
  };
}

async function limitOrderScheduler(p: any) {
  return createTriggerOrder(p, "limit-order");
}

async function takeProfitTrigger(p: any) {
  return createTriggerOrder(p, "take-profit");
}

async function stopLossGuard(p: any) {
  return createTriggerOrder(p, "stop-loss");
}

async function trailingStopLossEngine(p: any) {
  const { entryPrice, trailPercent, currentHighWaterMark } = p || {};
  if (!entryPrice || !trailPercent) {
    throw new Error("trailing-stop-loss-engine requires entryPrice and trailPercent");
  }
  const hwm = Math.max(currentHighWaterMark ?? entryPrice, entryPrice);
  const stopPrice = hwm * (1 - trailPercent / 100);

  // The trailing ceiling itself must be recomputed client-side on every
  // price tick (it has no fixed trigger price to submit on-chain).
  // Once price actually crosses `stopPrice`, submit a fresh stop-loss
  // Trigger order at that level via createTriggerOrder(...).
  return {
    ok: true,
    entryPrice,
    trailPercent,
    highWaterMark: hwm,
    currentStopPrice: stopPrice,
    action:
      currentHighWaterMark && currentHighWaterMark > hwm
        ? "hold"
        : "recalculated",
    note: "Recompute on each price tick; fire stop-loss-guard when price <= currentStopPrice.",
  };
}

/* ------------------------------------------------------------------ */
/* 9. dca-dollar-cost-averaging-scheduler (Jupiter Recurring program) */
/* ------------------------------------------------------------------ */
async function dcaScheduler(p: any) {
  const { inputMint, outputMint, inAmount, numberOfOrders, intervalSeconds, userPublicKey } = p || {};
  if (!inputMint || !outputMint || !inAmount || !numberOfOrders || !intervalSeconds || !userPublicKey) {
    throw new Error(
      "dca-dollar-cost-averaging-scheduler requires inputMint, outputMint, inAmount, numberOfOrders, intervalSeconds, userPublicKey"
    );
  }
  const res = await fetch(`${JUP_RECURRING}/createOrder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: userPublicKey,
      inputMint,
      outputMint,
      params: {
        time: {
          inAmount: String(inAmount),
          numberOfOrders: Number(numberOfOrders),
          interval: Number(intervalSeconds),
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jupiter Recurring createOrder failed: ${res.status}`);
  const data = await res.json();

  const queuePreview = Array.from({ length: Number(numberOfOrders) }, (_, i) => ({
    executionIndex: i,
    etaUnixSeconds: Math.floor(Date.now() / 1000) + i * Number(intervalSeconds),
    amount: String(inAmount),
  }));

  return {
    ok: true,
    order: data,
    unsignedTx: data.tx ?? null,
    queuePreview,
    note: "Sign & send to fund the recurring order account on-chain; execution is handled by Jupiter's keeper network per interval.",
  };
}

/* ------------------------------------------------------------------ */
/* 10. mev-sandwich-protection                                        */
/* ------------------------------------------------------------------ */
async function mevSandwichProtection(p: any) {
  const { tradeSizeUsd, poolLiquidityUsd } = p || {};
  if (!tradeSizeUsd || !poolLiquidityUsd) {
    throw new Error("mev-sandwich-protection requires tradeSizeUsd and poolLiquidityUsd");
  }
  const depthRatio = tradeSizeUsd / poolLiquidityUsd;
  // deeper mempool exposure (bigger trade relative to pool) -> tighten
  // minimum acceptable slippage and force private-RPC routing
  const minSlippageBps = Math.max(10, Math.min(500, Math.round(depthRatio * 10000 * 0.6)));
  const usePrivateRpc = depthRatio > 0.005; // >0.5% of pool depth

  return {
    ok: true,
    depthRatio: +depthRatio.toFixed(6),
    minSlippageBps,
    routing: usePrivateRpc
      ? { rpc: "jito", reason: "Trade size vs. pool depth exceeds sandwich-risk threshold" }
      : { rpc: "public", reason: "Trade size is small relative to pool depth" },
  };
}

/* ------------------------------------------------------------------ */
/* 11. sandwich-bot-exploit-revenue-share (protection telemetry)      */
/* ------------------------------------------------------------------ */
async function sandwichShieldTelemetry(p: any) {
  const { walletAddress, sinceUnix } = p || {};
  if (!walletAddress) throw new Error("sandwich-bot-exploit-revenue-share requires walletAddress");

  // Placeholder aggregate until wired to a real trade-history datastore;
  // structure matches what the UI panel expects to render.
  return {
    ok: true,
    walletAddress,
    sinceUnix: sinceUnix ?? null,
    shieldedTradeCount: 0,
    volumeShieldedUsd: 0,
    estimatedSavedUsd: 0,
    note: "Populate by joining this wallet's swap history against mev-sandwich-protection routing decisions once trade logging is wired to a database.",
  };
}

/* ------------------------------------------------------------------ */
/* 12. slippage-auto-optimizer                                        */
/* ------------------------------------------------------------------ */
async function slippageAutoOptimizer(p: any) {
  const { tradeSizeUsd, poolLiquidityUsd, volatility } = p || {};
  if (!tradeSizeUsd || !poolLiquidityUsd) {
    throw new Error("slippage-auto-optimizer requires tradeSizeUsd and poolLiquidityUsd");
  }
  const depthRatio = tradeSizeUsd / poolLiquidityUsd;
  const vol = volatility ?? 0.02; // fractional, default 2%
  const baseBps = 20;
  const depthComponent = depthRatio * 8000; // scales with % of pool consumed
  const volComponent = vol * 2000; // scales with recent volatility
  const recommendedBps = Math.round(Math.min(1000, baseBps + depthComponent + volComponent));

  return {
    ok: true,
    depthRatio: +depthRatio.toFixed(6),
    volatility: vol,
    recommendedSlippageBps: recommendedBps,
  };
}

/* ------------------------------------------------------------------ */
/* 13. robinhood-connect-fiat-onramp                                  */
/* ------------------------------------------------------------------ */
async function fiatOnramp(p: any) {
  const { userId, walletAddress, amountUsd } = p || {};
  if (!walletAddress) throw new Error("robinhood-connect-fiat-onramp requires walletAddress");
  if (!process.env.ROBINHOOD_CONNECT_APP_ID) {
    throw new Error("ROBINHOOD_CONNECT_APP_ID not configured");
  }

  const url = new URL("https://applink.robinhood.com/connect/crypto-transfer");
  url.searchParams.set("appId", process.env.ROBINHOOD_CONNECT_APP_ID);
  url.searchParams.set("walletAddress", walletAddress);
  if (amountUsd) url.searchParams.set("amount", String(amountUsd));
  if (userId) url.searchParams.set("externalUserId", userId);

  return { ok: true, sessionUrl: url.toString() };
}

/* ------------------------------------------------------------------ */
/* 14. wallet-pnl-realized-analytics                                  */
/* ------------------------------------------------------------------ */
async function realizedPnl(p: any) {
  const { fills } = p || {};
  if (!Array.isArray(fills)) {
    throw new Error("wallet-pnl-realized-analytics requires fills[]: {mint, side, amount, priceUsd, timestamp}");
  }

  // FIFO cost-basis matching per mint
  const lots: Record<string, { amount: number; priceUsd: number }[]> = {};
  const realized: Record<string, number> = {};

  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp);
  for (const f of sorted) {
    const { mint, side, amount, priceUsd } = f;
    lots[mint] = lots[mint] || [];
    realized[mint] = realized[mint] || 0;

    if (side === "buy") {
      lots[mint].push({ amount, priceUsd });
    } else if (side === "sell") {
      let remaining = amount;
      while (remaining > 0 && lots[mint].length > 0) {
        const lot = lots[mint][0];
        const matched = Math.min(lot.amount, remaining);
        realized[mint] += matched * (priceUsd - lot.priceUsd);
        lot.amount -= matched;
        remaining -= matched;
        if (lot.amount <= 0) lots[mint].shift();
      }
    }
  }

  const totalRealizedUsd = Object.values(realized).reduce((s, v) => s + v, 0);
  return { ok: true, byMint: realized, totalRealizedUsd };
}

/* ------------------------------------------------------------------ */
/* 15. wallet-unrealized-valuation                                    */
/* ------------------------------------------------------------------ */
async function unrealizedValuation(p: any) {
  const { holdings } = p || {};
  if (!Array.isArray(holdings)) {
    throw new Error(
      "wallet-unrealized-valuation requires holdings[]: {mint, amount, avgCostBasisUsd, currentPriceUsd}"
    );
  }

  const rows = holdings.map((h: any) => {
    const marketValueUsd = h.amount * h.currentPriceUsd;
    const costBasisUsd = h.amount * h.avgCostBasisUsd;
    const unrealizedPnlUsd = marketValueUsd - costBasisUsd;
    const unrealizedPnlPct = costBasisUsd > 0 ? (unrealizedPnlUsd / costBasisUsd) * 100 : 0;
    return { ...h, marketValueUsd, costBasisUsd, unrealizedPnlUsd, unrealizedPnlPct };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      marketValueUsd: acc.marketValueUsd + r.marketValueUsd,
      costBasisUsd: acc.costBasisUsd + r.costBasisUsd,
      unrealizedPnlUsd: acc.unrealizedPnlUsd + r.unrealizedPnlUsd,
    }),
    { marketValueUsd: 0, costBasisUsd: 0, unrealizedPnlUsd: 0 }
  );

  return { ok: true, rows, totals };
}
