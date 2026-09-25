"use client";

import { useMemo } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import type { WalletSigner } from "./agents-engine";
import { ensurePermit2Allowance, signAndAppendPermit2 } from "./permit2";

/**
 * Bridges the connected EVM wallet (via wagmi/viem) into the same
 * `WalletSigner` interface the Solana adapter uses. `payload` here is the
 * FULL 0x quote object returned by /api/v1/engine/feed's execute-swap-order
 * for chain: "bsc" — {transaction, permit2, issues, ...} — not just the
 * bare transaction, because the Permit2 flow needs the allowance/signature
 * fields too. Nothing here holds a private key — signing happens in the
 * browser extension via viem's WalletClient.
 */
export function useAppEvmWalletSigner(): WalletSigner | null {
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  return useMemo(() => {
    if (!isConnected || !address || !walletClient || !publicClient) return null;
    if (chainId !== 56) return null; // BSC mainnet only for now

    const signer: WalletSigner = {
      chain: "bsc",
      publicKey: address,
      signAndSend: async (quote: {
        transaction: { to: `0x${string}`; data: `0x${string}`; value?: string; gas?: string; gasPrice?: string };
        permit2?: { eip712: any };
        issues?: { allowance?: { spender: `0x${string}` } | null };
        sellToken: `0x${string}`;
      }) => {
        // 1. One-time Permit2 allowance approval, only if the quote says it's needed.
        const allowanceIssue = quote.issues?.allowance;
        if (allowanceIssue?.spender) {
          await ensurePermit2Allowance({
            publicClient,
            walletClient,
            owner: address,
            token: quote.sellToken, // the token being sold, NOT quote.transaction.to
            spender: allowanceIssue.spender,
          });
        }

        // 2. Sign the Permit2 EIP-712 message (if present) and splice it into calldata.
        const finalData = await signAndAppendPermit2(walletClient, address, quote as any);

        // 3. Send.
        const hash = await walletClient.sendTransaction({
          to: quote.transaction.to,
          data: finalData,
          value: quote.transaction.value ? BigInt(quote.transaction.value) : undefined,
          gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
          gasPrice: quote.transaction.gasPrice ? BigInt(quote.transaction.gasPrice) : undefined,
        });

        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      },
    };

    return signer;
  }, [isConnected, address, walletClient, publicClient, chainId]);
}
