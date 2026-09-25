/**
 * Client-side Execution Bay engine.
 *
 * Every call here hits our own Next.js route (/api/v1/engine/feed), which
 * returns either a quote/analytics payload, or an UNSIGNED transaction /
 * order payload that still needs the connected wallet to sign. Nothing in
 * this file ever touches a private key.
 */

export type LogFn = (line: string) => void;

const ENGINE_URL = "/api/v1/engine/feed";

async function callEngine(tool: string, params: Record<string, any>, log?: LogFn) {
  log?.(`[ENGINE]: Dispatching ${tool}...`);
  const res = await fetch(ENGINE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, params }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    log?.(`[ENGINE]: ERROR in ${tool} — ${data.error ?? res.statusText}`);
    throw new Error(data.error ?? `Engine call failed: ${tool}`);
  }
  log?.(`[ENGINE]: ${tool} complete.`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Wallet signing hook contract                                       */
/* ------------------------------------------------------------------ */
export interface WalletSigner {
  chain: "solana" | "bsc";
  publicKey: string;
  /** Given a base64 Solana tx or an EVM tx object, sign + send, return the tx hash/signature. */
  signAndSend: (payload: any) => Promise<string>;
}

/* ------------------------------------------------------------------ */
/* submitAutomatedTradeOrder                                          */
/* ------------------------------------------------------------------ */
export interface AutomatedOrderParams {
  orderType:
    | "swap"
    | "limit"
    | "take-profit"
    | "stop-loss"
    | "trailing-stop"
    | "dca";
  chain: "solana" | "bsc";
  inputMint: string;
  outputMint: string;
  amount: string; // base units for swap/limit/dca "makingAmount"/"inAmount"
  takingAmount?: string; // limit / take-profit / stop-loss target amount
  slippageBps?: number;
  gasMode?: "standard" | "fast" | "turbo";
  jitoShield?: boolean;
  trailPercent?: number;
  entryPrice?: number;
  dca?: { numberOfOrders: number; intervalSeconds: number };
  wallet: WalletSigner;
}

export async function submitAutomatedTradeOrder(
  params: AutomatedOrderParams,
  log?: LogFn
): Promise<{ signature: string | null; details: any }> {
  const { orderType, chain, inputMint, outputMint, amount, takingAmount, wallet } = params;

  log?.(`[ENGINE]: Building ${chain === "solana" ? "Jupiter v6" : "BSC"} payload with 50bps fee...`);

  // 1. Priority fee / gas
  const gas = await callEngine(
    "priority-gas-booster",
    { chain, mode: params.gasMode ?? "standard" },
    log
  );

  // 2. Optional MEV shield (Solana only)
  let jito: any = null;
  if (chain === "solana" && params.jitoShield) {
    log?.(`[ENGINE]: Broadcasting via Jito MEV Shield...`);
    jito = await callEngine("jito-mev-bundle-shield", {}, log);
  }

  // 3. Auto-slippage if not explicitly set
  let slippageBps = params.slippageBps;
  if (slippageBps == null) {
    const opt = await callEngine(
      "slippage-auto-optimizer",
      { tradeSizeUsd: Number(amount), poolLiquidityUsd: 1_000_000 },
      log
    );
    slippageBps = opt.recommendedSlippageBps;
  }

  let result: any;
  switch (orderType) {
    case "swap":
      result = await callEngine(
        "execute-swap-order",
        { chain, inputMint, outputMint, amount, userPublicKey: wallet.publicKey, slippageBps },
        log
      );
      break;
    case "limit":
      result = await callEngine(
        "limit-order-scheduler",
        { inputMint, outputMint, makingAmount: amount, takingAmount, userPublicKey: wallet.publicKey },
        log
      );
      break;
    case "take-profit":
      result = await callEngine(
        "take-profit-trigger",
        { inputMint, outputMint, makingAmount: amount, takingAmount, userPublicKey: wallet.publicKey },
        log
      );
      break;
    case "stop-loss":
      result = await callEngine(
        "stop-loss-guard",
        { inputMint, outputMint, makingAmount: amount, takingAmount, userPublicKey: wallet.publicKey },
        log
      );
      break;
    case "trailing-stop":
      result = await callEngine(
        "trailing-stop-loss-engine",
        { entryPrice: params.entryPrice, trailPercent: params.trailPercent },
        log
      );
      // trailing-stop returns a monitored ceiling, not a signable tx —
      // hand back early, the UI should keep polling this on a timer.
      return { signature: null, details: { gas, result } };
    case "dca":
      if (!params.dca) throw new Error("dca order requires params.dca");
      result = await callEngine(
        "dca-dollar-cost-averaging-scheduler",
        {
          inputMint,
          outputMint,
          inAmount: amount,
          numberOfOrders: params.dca.numberOfOrders,
          intervalSeconds: params.dca.intervalSeconds,
          userPublicKey: wallet.publicKey,
        },
        log
      );
      break;
    default:
      throw new Error(`Unknown orderType: ${orderType}`);
  }

  const payload = result.swapTransaction ?? result.unsignedTx ?? result.order?.tx;
  if (!payload) {
    log?.(`[ENGINE]: No signable payload returned — likely a quote-only response.`);
    return { signature: null, details: { gas, jito, result } };
  }

  log?.(`[ENGINE]: Awaiting wallet signature...`);
  const signature = await wallet.signAndSend(payload);
  log?.(`[ENGINE]: Broadcast confirmed — ${signature.slice(0, 8)}...`);

  return { signature, details: { gas, jito, result } };
}

/* ------------------------------------------------------------------ */
/* executeMultiWalletBatch                                            */
/* ------------------------------------------------------------------ */
export interface MultiWalletBatchParams {
  totalAmount: string;
  wallets: { address: string; weight?: number; signer: WalletSigner }[];
  mode?: "even" | "weighted";
  chain: "solana" | "bsc";
  inputMint: string;
  outputMint: string;
  slippageBps?: number;
}

export async function executeMultiWalletBatch(
  params: MultiWalletBatchParams,
  log?: LogFn
): Promise<{ address: string; signature: string | null; amount: string; error?: string }[]> {
  const { totalAmount, wallets, mode, chain, inputMint, outputMint, slippageBps } = params;

  log?.(`[ENGINE]: Splitting ${totalAmount} across ${wallets.length} wallet(s)...`);
  const split = await callEngine(
    "multi-wallet-batch",
    { totalAmount, wallets: wallets.map((w) => ({ address: w.address, weight: w.weight })), mode },
    log
  );

  const results: { address: string; signature: string | null; amount: string; error?: string }[] = [];

  for (const alloc of split.allocations) {
    const w = wallets.find((x) => x.address === alloc.address);
    if (!w) {
      results.push({ address: alloc.address, signature: null, amount: alloc.amount, error: "signer not found" });
      continue;
    }
    try {
      log?.(`[ENGINE]: Executing leg ${alloc.address.slice(0, 6)}... for ${alloc.amount}`);
      const { signature } = await submitAutomatedTradeOrder(
        {
          orderType: "swap",
          chain,
          inputMint,
          outputMint,
          amount: alloc.amount,
          slippageBps,
          wallet: w.signer,
        },
        log
      );
      results.push({ address: alloc.address, signature, amount: alloc.amount });
    } catch (err: any) {
      log?.(`[ENGINE]: Leg ${alloc.address.slice(0, 6)}... failed — ${err.message}`);
      results.push({ address: alloc.address, signature: null, amount: alloc.amount, error: err.message });
    }
  }

  log?.(`[ENGINE]: Multi-wallet batch complete — ${results.filter((r) => r.signature).length}/${results.length} legs filled.`);
  return results;
}
