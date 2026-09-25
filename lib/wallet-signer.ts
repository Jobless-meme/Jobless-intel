"use client";

import { useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import type { WalletSigner } from "./agents-engine";

/**
 * Bridges the connected Solana wallet-adapter wallet into the
 * `WalletSigner` interface the Execution Bay engine calls. Nothing here
 * touches a private key directly — signing happens inside the wallet
 * extension (Phantom/Solflare) via `signTransaction`.
 *
 * BSC/EVM note: agents-engine.ts also accepts chain: "bsc" signers, but
 * this hook only covers Solana for now. Add a wagmi-based counterpart
 * the same way (useAccount + useSignTransaction/useSendTransaction) when
 * you're ready to wire up BSC execution.
 */
export function useAppWalletSigner(): WalletSigner | null {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();

  return useMemo(() => {
    if (!connected || !publicKey || !signTransaction) return null;

    const signer: WalletSigner = {
      chain: "solana",
      publicKey: publicKey.toBase58(),
      signAndSend: async (payload: string) => {
        // payload is the base64-encoded unsigned VersionedTransaction
        // returned by /api/v1/engine/feed (execute-swap-order, trigger
        // orders, recurring/DCA orders all return this same shape).
        const txBytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        const tx = VersionedTransaction.deserialize(txBytes);

        const signedTx = await signTransaction(tx);
        const signature = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });

        const latestBlockhash = await connection.getLatestBlockhash();
        await connection.confirmTransaction(
          { signature, ...latestBlockhash },
          "confirmed"
        );

        return signature;
      },
    };

    return signer;
  }, [connected, publicKey, signTransaction, connection]);
}
