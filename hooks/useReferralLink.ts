"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";

/** Default code: the first 8 chars of the wallet address. Public, stable,
 * and unique enough (58^8) — but it's just the DEFAULT; if the user already
 * has a referral_stats row, that row's code wins. */
export function deriveReferralCode(wallet: string): string {
  return wallet.slice(0, 8);
}

/**
 * Referral code + link for the share card.
 *
 * The card never waits on the network: it gets the derived code right
 * away, then swaps to the stored one if the user has a referral_stats row
 * (or files the derived code there on first use, when they're signed in).
 *
 * NOTE: this only GENERATES links. Nothing in the app reads `?ref=` yet —
 * turning a visit into users.referred_by / referral_stats counts needs a
 * capture step (and a server-side write) that isn't part of this slice.
 */
export function useReferralLink(wallet: string | null) {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) {
      setCode(null);
      return;
    }
    const fallback = deriveReferralCode(wallet);
    setCode(fallback);

    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth.user?.id;
        if (!uid) return; // not signed in — the derived code still works on the card

        const { data } = await supabase
          .from("referral_stats")
          .select("referral_code")
          .eq("user_id", uid)
          .maybeSingle();
        if (data?.referral_code) {
          if (!cancelled) setCode(data.referral_code);
          return;
        }
        // referral_code is UNIQUE; a collision just errors and we keep the derived code.
        await supabase.from("referral_stats").insert({ user_id: uid, referral_code: fallback });
      } catch {
        /* Supabase not configured / offline — derived code stands */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const url = code && typeof window !== "undefined" ? `${window.location.origin}/?ref=${encodeURIComponent(code)}` : null;
  return { code, url };
}
