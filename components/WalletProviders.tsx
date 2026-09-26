"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

// These provider components ship without an explicit `children` prop in
// their TypeScript types, which trips up strict React 18 typings. Casting
// them here is purely a compile-time fix — no change in runtime behavior.
const ConnectionProviderFixed = ConnectionProvider as unknown as React.FC<{
  endpoint: string;
  children?: React.ReactNode;
}>;
const WalletProviderFixed = WalletProvider as unknown as React.FC<{
  wallets: any[];
  autoConnect?: boolean;
  children?: React.ReactNode;
}>;
const WalletModalProviderFixed = WalletModalProvider as unknown as React.FC<{
  children?: React.ReactNode;
}>;

/**
 * Wraps the app in Solana wallet context. Defaults to mainnet-beta via a
 * public RPC — swap NEXT_PUBLIC_SOLANA_RPC_URL in .env for a real
 * (rate-limit-friendly) RPC provider (Helius, Triton, QuickNode, etc.)
 * before shipping past local dev.
 */
export default function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl("mainnet-beta");

  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProviderFixed endpoint={endpoint}>
      <WalletProviderFixed wallets={wallets} autoConnect>
        <WalletModalProviderFixed>{children}</WalletModalProviderFixed>
      </WalletProviderFixed>
    </ConnectionProviderFixed>
  );
}
