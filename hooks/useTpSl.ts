"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { getBurnerKeypair, listBurners } from "@/lib/burner-vault";
import { submitAutomatedTradeOrder, type WalletSigner } from "@/lib/agents-engine";
import {
  fetchLivePricesUsd,
  positionMonitor,
  type TpSlOrderKind,
  type TpSlRule,
  type TpSlRuleStatus,
  type TpSlTickState,
} from "@/lib/tpsl-engine";
import { VersionedTransaction } from "@solana/web3.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/** DB row shape (snake_case) <-> engine's TpSlRule (camelCase). */
interface TpSlOrderRow {
  id: string;
  wallet_address: string;
  signer_id: string;
  chain: "solana";
  token_mint: string;
  token_symbol: string | null;
  token_amount: number;
  entry_price_usd: number;
  order_kind: TpSlOrderKind;
  target_pct: number | null;
  trail_percent: number | null;
  high_water_mark_usd: number | null;
  status: TpSlRuleStatus;
  trigger_tx_signature: string | null;
  last_error: string | null;
  created_at: string;
  triggered_at: string | null;
}

function rowToRule(row: TpSlOrderRow): TpSlRule {
  return {
    id: row.id,
    walletPublicKey: row.wallet_address,
    signerId: row.signer_id,
    chain: row.chain,
    tokenMint: row.token_mint,
    tokenSymbol: row.token_symbol ?? "",
    tokenAmount: row.token_amount,
    entryPriceUsd: row.entry_price_usd,
    kind: row.order_kind,
    targetPct: row.target_pct,
    trailPercent: row.trail_percent,
    highWaterMarkUsd: row.high_water_mark_usd,
    status: row.status,
    createdAt: new Date(row.created_at).getTime(),
    triggeredAt: row.triggered_at ? new Date(row.triggered_at).getTime() : null,
    triggerSignature: row.trigger_tx_signature,
    lastError: row.last_error,
  };
}

export interface CreateTpSlRuleInput {
  walletPublicKey: string;
  /** "wallet-adapter" or a burner id from lib/burner-vault.ts. */
  signerId: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** UI units (e.g. 1_500_000 tokens), not base units — converted internally. */
  tokenAmount: number;
  entryPriceUsd: number;
  kind: TpSlOrderKind;
  targetPct?: number; // required for take-profit / stop-loss
  trailPercent?: number; // required for trailing-stop
}

function toBaseUnits(uiAmount: number, decimals: number): string {
  return String(Math.max(0, Math.floor(uiAmount * 10 ** decimals)));
}

/**
 * Manages active TP/SL/trailing rules: Supabase persistence (so the panel
 * survives a refresh) + the live polling monitor from lib/tpsl-engine.ts
 * (so PnL / distance-to-trigger update in real time and exits actually
 * fire while this tab is open — see that file's module comment for what
 * "active" does and doesn't guarantee).
 */
export function useTpSl(wallet: WalletSigner | null) {
  const { connection } = useConnection();
  const [rules, setRules] = useState<TpSlRule[]>([]);

  const states = useSyncExternalStore<Record<string, TpSlTickState>>(
    useCallback((cb) => positionMonitor.subscribe(cb), []),
    useCallback(() => positionMonitor.getSnapshot(), []),
    useCallback(() => ({}), [])
  );

  const loadRules = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("user_tpsl_orders")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as TpSlOrderRow[]).map(rowToRule);
  }, []);

  // Resolve a signer for a given signerId and fire the market-sell exit via
  // the same Execution Bay route everything else in the app uses. Kept
  // here (not in tpsl-engine.ts) so the engine module stays signing-agnostic.
  const executeExit = useCallback(
    async (rule: TpSlRule): Promise<string | null> => {
      let signer: WalletSigner;
      if (rule.signerId === "wallet-adapter") {
        if (!wallet || wallet.publicKey !== rule.walletPublicKey) {
          throw new Error("Connected wallet doesn't match this rule's wallet — reconnect to execute.");
        }
        signer = wallet;
      } else {
        const kp = getBurnerKeypair(rule.signerId); // throws if missing/tampered — never silently signs as the wrong key
        signer = {
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

      // NOTE on units: rule.tokenAmount is expected in base units (i.e.
      // already multiplied by the token's decimals), same convention as
      // AutomatedOrderParams.amount elsewhere in the Execution Bay — the
      // panel/hook that builds a rule from a live position must convert
      // the UI-displayed token amount before calling createRule().
      const { signature } = await submitAutomatedTradeOrder(
        {
          orderType: "swap",
          chain: "solana",
          inputMint: rule.tokenMint,
          outputMint: SOL_MINT,
          amount: String(Math.floor(rule.tokenAmount)),
          wallet: signer,
        },
        undefined
      );
      return signature;
    },
    [wallet, connection]
  );

  useEffect(() => {
    positionMonitor.setExecutor(executeExit);
  }, [executeExit]);

  const syncFromSupabase = useCallback(async () => {
    const fresh = await loadRules();
    positionMonitor.setRules(fresh);
    setRules(fresh);
    return fresh;
  }, [loadRules]);

  useEffect(() => {
    void syncFromSupabase();
    return () => positionMonitor.stop();
  }, [syncFromSupabase]);

  /** Creates a rule row and, for fixed TP/SL, also files the real on-chain
   * Jupiter Trigger order so the exit doesn't depend on this tab staying
   * open (trailing-stop can't be pre-filed — see lib/tpsl-engine.ts). */
  const createRule = useCallback(
    async (input: CreateTpSlRuleInput) => {
      if (input.kind === "trailing-stop" && !input.trailPercent) {
        throw new Error("trailing-stop requires trailPercent");
      }
      if (input.kind !== "trailing-stop" && input.targetPct == null) {
        throw new Error(`${input.kind} requires targetPct`);
      }

      const supabase = getSupabaseBrowserClient();
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Sign in with your wallet first (SIWS) to save risk rules.");

      // Stored (and later re-hydrated into TpSlRule) in BASE units
      // throughout, so executeExit never has to guess decimals again.
      const amountBaseUnits = toBaseUnits(input.tokenAmount, input.tokenDecimals);

      const { data, error } = await supabase
        .from("user_tpsl_orders")
        .insert({
          user_id: userId,
          wallet_address: input.walletPublicKey,
          signer_id: input.signerId,
          chain: "solana",
          token_mint: input.tokenMint,
          token_symbol: input.tokenSymbol,
          token_amount: Number(amountBaseUnits),
          entry_price_usd: input.entryPriceUsd,
          order_kind: input.kind,
          target_pct: input.kind === "trailing-stop" ? null : input.targetPct,
          trail_percent: input.kind === "trailing-stop" ? input.trailPercent : null,
          high_water_mark_usd: input.kind === "trailing-stop" ? input.entryPriceUsd : null,
        })
        .select("*")
        .single();
      if (error) throw error;

      const rule = rowToRule(data as TpSlOrderRow);
      positionMonitor.upsertRule(rule);
      setRules((prev) => [rule, ...prev]);

      // Mirror fixed TP/SL on-chain — best-effort: the local rule/panel
      // still works for live PnL + a browser-tab exit even if this fails,
      // it just loses the "survives a closed browser" guarantee.
      if (wallet && (input.kind === "take-profit" || input.kind === "stop-loss") && input.targetPct != null) {
        try {
          const targetPriceUsd = input.entryPriceUsd * (1 + input.targetPct / 100);
          const [solPriceUsd] = Object.values(await fetchLivePricesUsd([SOL_MINT]));
          if (solPriceUsd) {
            const outputSol = (input.tokenAmount * targetPriceUsd) / solPriceUsd;
            const takingAmountLamports = String(Math.max(1, Math.floor(outputSol * 1e9)));
            await submitAutomatedTradeOrder({
              orderType: input.kind,
              chain: "solana",
              inputMint: input.tokenMint,
              outputMint: SOL_MINT,
              amount: amountBaseUnits,
              takingAmount: takingAmountLamports,
              wallet,
            });
          }
        } catch {
          /* on-chain mirror failed (e.g. no fee account configured, or SOL
             price unavailable this tick) — the local rule above still
             stands and the browser-tab monitor will still fire it. */
        }
      }

      return rule;
    },
    [wallet]
  );

  const cancelRule = useCallback(async (id: string) => {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.from("user_tpsl_orders").update({ status: "cancelled" }).eq("id", id);
    if (error) throw error;
    positionMonitor.removeRule(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return {
    /** Active rules loaded from Supabase, newest first. */
    rules,
    /** Live per-rule state (pnlPct, distancePct, currentStopPriceUsd, isTriggered), keyed by rule id. */
    states,
    /** Re-pulls active rules from Supabase and hands them to the monitor. Call after createRule/cancelRule if you're not relying on their built-in updates. */
    refresh: syncFromSupabase,
    createRule,
    cancelRule,
    /** Local burner wallets available as a signerId for unattended (no wallet-popup) execution. */
    availableBurners: () => listBurners(),
  };
}
