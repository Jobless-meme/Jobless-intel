"use client";

import { Keypair } from "@solana/web3.js";
import { getOrCreateBurnerWallet, hasBurnerWallet } from "./copy-trading";

/**
 * Multi-burner registry for batch trading.
 *
 * Same zero-custody model as lib/copy-trading.ts: every secret key lives in
 * THIS browser's localStorage, plaintext, and is only ever used to sign
 * locally. Nothing here (or anywhere in the batch engine) sends a secret key
 * to the server — the engine route only ever sees public keys.
 *
 * The single copy-trade key from lib/copy-trading.ts is adopted as wallet
 * "legacy" (read-only from here) so Copy and Batch share one funded wallet
 * instead of forking your SOL across two. Additional wallets live in their
 * own registry key.
 */

const REGISTRY_KEY = "lx_burner_registry_v2";

export const LEGACY_BURNER_ID = "legacy";
export const MAX_BURNERS = 10;

interface StoredBurner {
  id: string;
  label: string;
  publicKey: string;
  secretKey: number[];
  createdAt: number;
}

/** Public view of a burner — never includes the secret key. */
export interface BurnerInfo {
  id: string;
  label: string;
  publicKey: string;
  createdAt: number;
  /** The shared copy-trade wallet. Managed from the Copy tab, not deletable here. */
  legacy: boolean;
}

function isStoredBurner(v: unknown): v is StoredBurner {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.label === "string" &&
    typeof b.publicKey === "string" &&
    typeof b.createdAt === "number" &&
    Array.isArray(b.secretKey) &&
    b.secretKey.length === 64
  );
}

function readRegistry(): StoredBurner[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isStoredBurner) : [];
  } catch {
    return [];
  }
}

function writeRegistry(list: StoredBurner[]) {
  window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(list));
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** All local burners, copy-trade wallet first. Safe to call on every render tick. */
export function listBurners(): BurnerInfo[] {
  const out: BurnerInfo[] = [];

  if (hasBurnerWallet()) {
    try {
      // hasBurnerWallet() is true, so this reads the stored key — it never generates one.
      const kp = getOrCreateBurnerWallet();
      out.push({
        id: LEGACY_BURNER_ID,
        label: "Copy-Trade Wallet",
        publicKey: kp.publicKey.toBase58(),
        createdAt: 0,
        legacy: true,
      });
    } catch {
      /* corrupted legacy key — skip it rather than break the whole list */
    }
  }

  for (const b of readRegistry()) {
    out.push({ id: b.id, label: b.label, publicKey: b.publicKey, createdAt: b.createdAt, legacy: false });
  }
  return out;
}

/** Generates and stores a fresh session wallet. Throws if the cap is reached. */
export function createBurner(): BurnerInfo {
  const registry = readRegistry();
  const total = registry.length + (hasBurnerWallet() ? 1 : 0);
  if (total >= MAX_BURNERS) {
    throw new Error(`Session wallet limit reached (${MAX_BURNERS}). Delete an empty one first.`);
  }

  // "Session N" — N is one past the highest existing number so labels never repeat.
  const highest = registry.reduce((max, b) => {
    const m = /^Session (\d+)$/.exec(b.label);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);

  const kp = Keypair.generate();
  const record: StoredBurner = {
    id: newId(),
    label: `Session ${highest + 1}`,
    publicKey: kp.publicKey.toBase58(),
    secretKey: Array.from(kp.secretKey),
    createdAt: Date.now(),
  };
  writeRegistry([...registry, record]);
  return { id: record.id, label: record.label, publicKey: record.publicKey, createdAt: record.createdAt, legacy: false };
}

/**
 * Loads a burner's signing keypair. The returned Keypair should be used
 * immediately and dropped — never store it in React state or a global.
 * Verifies the stored public key still matches the secret so a corrupted
 * or tampered entry can never sign as a different address than the UI showed.
 */
export function getBurnerKeypair(id: string): Keypair {
  if (id === LEGACY_BURNER_ID) {
    if (!hasBurnerWallet()) throw new Error("Copy-trade wallet no longer exists on this device.");
    return getOrCreateBurnerWallet();
  }

  const rec = readRegistry().find((b) => b.id === id);
  if (!rec) throw new Error("Session wallet not found on this device.");
  const kp = Keypair.fromSecretKey(Uint8Array.from(rec.secretKey));
  if (kp.publicKey.toBase58() !== rec.publicKey) {
    throw new Error(`Stored key for ${rec.label} does not match its address — refusing to sign.`);
  }
  return kp;
}

/** Permanently deletes a session wallet's key. Any SOL still in it becomes unrecoverable. */
export function removeBurner(id: string) {
  if (id === LEGACY_BURNER_ID) {
    throw new Error("The copy-trade wallet is managed from the Copy tab.");
  }
  writeRegistry(readRegistry().filter((b) => b.id !== id));
}
