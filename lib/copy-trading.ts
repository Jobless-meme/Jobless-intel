"use client";

import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { WalletSigner } from "./agents-engine";

/**
 * Auto-Copy needs to sign trades without a wallet-extension popup every
 * time — that's the whole point of "automatic". The only non-custodial
 * way to do that is a session/burner keypair the browser holds and signs
 * with directly, funded separately and on purpose by the user.
 *
 * This is a real, meaningful risk trade-off, not a technicality:
 *   - The secret key lives in this browser's localStorage, plaintext.
 *   - Anyone with access to this browser/device can drain the burner wallet.
 *   - It is NOT connected to your main wallet's funds — only whatever you
 *     explicitly transfer into it is at risk.
 * Fund it with only what you're willing to lose, the same way you would
 * for any hot-wallet trading bot (including GMGN's own).
 */

const STORAGE_KEY = "lx_copytrading_burner_v1";

export function getOrCreateBurnerWallet(): Keypair {
  if (typeof window === "undefined") throw new Error("Burner wallet is client-only");
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const secret = Uint8Array.from(JSON.parse(stored));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function hasBurnerWallet(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.localStorage.getItem(STORAGE_KEY);
}

export function deleteBurnerWallet() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

/** Wraps the burner keypair as a WalletSigner — signs immediately, no
 * extension prompt, so submitAutomatedTradeOrder() can be called from an
 * event handler with nobody watching. */
export function getBurnerSigner(connection: Connection): WalletSigner {
  const kp = getOrCreateBurnerWallet();
  return {
    chain: "solana",
    publicKey: kp.publicKey.toBase58(),
    signAndSend: async (payloadBase64: string) => {
      const txBytes = Uint8Array.from(atob(payloadBase64), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([kp]);
      const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
      return signature;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tracked wallets — persisted locally, per-browser                   */
/* ------------------------------------------------------------------ */

export interface TrackedWallet {
  address: string;
  label?: string;
  autoCopyEnabled: boolean;
  copyAmountSol: number; // fixed SOL size per mirrored buy
  addedAt: number;
}

const TRACKED_KEY = "lx_tracked_wallets_v1";

export function getTrackedWallets(): TrackedWallet[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(TRACKED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveTrackedWallets(wallets: TrackedWallet[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRACKED_KEY, JSON.stringify(wallets));
}

export function addTrackedWallet(address: string, label?: string) {
  const wallets = getTrackedWallets();
  if (wallets.some((w) => w.address === address)) return wallets;
  const next = [...wallets, { address, label, autoCopyEnabled: false, copyAmountSol: 0.05, addedAt: Date.now() }];
  saveTrackedWallets(next);
  return next;
}

export function removeTrackedWallet(address: string) {
  const next = getTrackedWallets().filter((w) => w.address !== address);
  saveTrackedWallets(next);
  return next;
}

export function updateTrackedWallet(address: string, patch: Partial<TrackedWallet>) {
  const next = getTrackedWallets().map((w) => (w.address === address ? { ...w, ...patch } : w));
  saveTrackedWallets(next);
  return next;
}
