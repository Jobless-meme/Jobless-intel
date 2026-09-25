"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getSupabaseBrowserClient } from "./supabase-client";

export type WalletAuthStatus = "idle" | "signing" | "linking" | "linked" | "error";

export function useWalletAuth() {
  const { publicKey, signMessage } = useWallet();
  const [status, setStatus] = useState<WalletAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const signInWithWallet = useCallback(async () => {
    if (!publicKey) {
      setError("Connect a Solana wallet first");
      setStatus("error");
      return;
    }
    if (!signMessage) {
      setError("This wallet doesn't support message signing");
      setStatus("error");
      return;
    }

    setError(null);
    try {
      // 1. Get a fresh challenge nonce for this wallet.
      setStatus("signing");
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: publicKey.toBase58() }),
      });
      const nonceData = await nonceRes.json();
      if (!nonceRes.ok) throw new Error(nonceData.error ?? "Failed to get sign-in challenge");

      // 2. Have the wallet sign it — this proves ownership, no
      // transaction, no gas, nothing is broadcast to the chain.
      const signatureBytes = await signMessage(new TextEncoder().encode(nonceData.message));
      const signatureBase64 = (() => {
        let binary = "";
        for (const byte of signatureBytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      })();

      // 3. Establish a real Supabase Auth session. Anonymous auth is a
      // free, first-class Supabase feature — this is what makes
      // auth.uid() in RLS policies actually resolve to something.
      setStatus("linking");
      const supabase = getSupabaseBrowserClient();
      const { data: existingSession } = await supabase.auth.getSession();
      let accessToken = existingSession.session?.access_token;
      if (!accessToken) {
        const { data: anonData, error: anonErr } = await supabase.auth.signInAnonymously();
        if (anonErr) throw anonErr;
        accessToken = anonData.session?.access_token;
      }
      if (!accessToken) throw new Error("Failed to establish a Supabase session");

      // 4. Server verifies the signature and links this wallet to the
      // now-authenticated session's identity.
      const linkRes = await fetch("/api/auth/link-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey: publicKey.toBase58(),
          signature: signatureBase64,
          accessToken,
        }),
      });
      const linkData = await linkRes.json();
      if (!linkRes.ok) throw new Error(linkData.error ?? "Failed to link wallet");

      setUserId(linkData.userId);
      setStatus("linked");
    } catch (err: any) {
      setError(err.message ?? "Sign-in failed");
      setStatus("error");
    }
  }, [publicKey, signMessage]);

  return { status, error, userId, signInWithWallet };
}
