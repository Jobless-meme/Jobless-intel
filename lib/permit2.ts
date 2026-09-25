import { erc20Abi, encodeFunctionData, concat, numberToHex, size, maxUint256 } from "viem";
import type { PublicClient, WalletClient } from "viem";

/**
 * 0x Permit2 flow (https://docs.0x.org/.../permit2):
 *  1. One-time ERC20 approve(PERMIT2_ADDRESS, maxUint256) per token, if not
 *     already approved — the quote response tells us if this is needed via
 *     `issues.allowance`.
 *  2. Sign the `permit2.eip712` typed data from the quote.
 *  3. Append <32-byte big-endian signature length><signature bytes> to the
 *     quote's `transaction.data`.
 *  4. Send the resulting transaction.
 *
 * Skipping any of these steps means the swap either reverts on-chain or,
 * worse, silently fails — this is the gap flagged after the first BSC wire-up.
 */

export async function ensurePermit2Allowance(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  owner: `0x${string}`;
  token: `0x${string}`;
  spender: `0x${string}`;
}) {
  const { publicClient, walletClient, owner, token, spender } = opts;

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });

  if (allowance > 0n) return; // already approved — Permit2 approvals are typically one-time & max

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });

  const hash = await walletClient.sendTransaction({ account: owner, chain: undefined, to: token, data });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Signs quote.permit2.eip712 (if present) and returns transaction.data with
 * the signature appended in 0x's required format. If the quote has no
 * permit2 object (e.g. native-token sells don't need one), returns the
 * original calldata untouched. */
export async function signAndAppendPermit2(
  walletClient: WalletClient,
  account: `0x${string}`,
  quote: { permit2?: { eip712: any }; transaction: { data: `0x${string}` } }
): Promise<`0x${string}`> {
  if (!quote.permit2?.eip712) return quote.transaction.data;

  const signature = await walletClient.signTypedData({ account, ...quote.permit2.eip712 });
  const sigLengthHex = numberToHex(size(signature), { size: 32 });

  return concat([quote.transaction.data, sigLengthHex, signature]) as `0x${string}`;
}
