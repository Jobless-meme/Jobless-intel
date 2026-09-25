import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import WalletProviders from "@/components/WalletProviders";
import WagmiProviders from "@/components/WagmiProviders";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Jobless Intel — Trading Terminal",
  description: "Jobless Intel: a multi-chain trading terminal.",
};

// Initial value only — TerminalApp updates this live as the theme changes.
export const viewport: Viewport = {
  themeColor: "#05070D",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        <WagmiProviders>
          <WalletProviders>{children}</WalletProviders>
        </WagmiProviders>
      </body>
    </html>
  );
}
