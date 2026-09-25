import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { PublicClient } from "viem";
import { formatUnits } from "viem";

export interface SplTokenBalance {
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
}

/** Native SOL balance, in SOL. */
export async function getSolBalance(connection: Connection, owner: string): Promise<number> {
  const lamports = await connection.getBalance(new PublicKey(owner));
  return lamports / LAMPORTS_PER_SOL;
}

/** All SPL token balances for a wallet (non-zero only). Uses a single
 * getParsedTokenAccountsByOwner call against the classic SPL Token program —
 * doesn't cover Token-2022 mints, add a second call with that program id if
 * you need those too. */
export async function getSplTokenBalances(connection: Connection, owner: string): Promise<SplTokenBalance[]> {
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
    programId: TOKEN_PROGRAM_ID,
  });

  return res.value
    .map((acc) => {
      const info = acc.account.data.parsed.info;
      const amount = info.tokenAmount;
      return {
        mint: info.mint as string,
        amountRaw: amount.amount as string,
        decimals: amount.decimals as number,
        uiAmount: (amount.uiAmount as number) ?? 0,
      };
    })
    .filter((t) => t.uiAmount > 0);
}

/** Native BNB balance, in BNB. */
export async function getBnbBalance(publicClient: PublicClient, owner: `0x${string}`): Promise<number> {
  const wei = await publicClient.getBalance({ address: owner });
  return Number(formatUnits(wei, 18));
}

/** Balance of a specific BEP-20 token. BSC has no free, keyless
 * "list all tokens a wallet holds" endpoint the way Solana's RPC does, so
 * BEP-20 balances have to be checked one known token at a time (or via a
 * paid indexer like Moralis/Covalent/Bitquery — not wired up here). */
export async function getBep20Balance(
  publicClient: PublicClient,
  owner: `0x${string}`,
  token: `0x${string}`
): Promise<{ raw: bigint; decimals: number; uiAmount: number }> {
  const erc20Abi = [
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  ] as const;

  const [raw, decimals] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);

  return { raw, decimals, uiAmount: Number(formatUnits(raw, decimals)) };
}
