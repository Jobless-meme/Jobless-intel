"use client";

import { useState } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { bsc } from "wagmi/chains";
import { injected } from "wagmi/connectors/injected";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * BSC wallet context via wagmi + viem. Uses the browser's injected
 * provider (MetaMask, Trust Wallet, etc.) — no WalletConnect project ID
 * required to get started. Add the walletConnect() connector later if you
 * want mobile/QR connections too.
 */
const wagmiConfig = createConfig({
  chains: [bsc],
  connectors: [injected()],
  transports: {
    [bsc.id]: http(process.env.NEXT_PUBLIC_BSC_RPC_URL || "https://bsc-dataseed.binance.org"),
  },
});

export default function WagmiProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
