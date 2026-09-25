"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { LogFn } from "@/lib/agents-engine";
import { humanizeError } from "@/lib/batch-trading";
import { getBurnerKeypair } from "@/lib/burner-vault";
import {
  MAX_SWEEP_WALLETS,
  executeSweep,
  initialSweepLegStates,
  prepareSweep,
  validateDestination,
  type SweepLegState,
  type SweepMode,
  type SweepPlan,
  type SweepWalletInput,
} from "@/lib/batch-sweep";
import type { BatchWalletView } from "./useBatchTrading";

/**
 * Sweep controller — lives as local component state rather than the
 * module-level store useBatchTrading uses, because a sweep is a handful of
 * quick native transfers (not a long-running multi-leg swap session): it's
 * fine for it to reset if the sheet unmounts mid-run. If that stops being
 * true, lift this into a useSyncExternalStore store the same way batch
 * trading does.
 */

export type SweepPhase = "idle" | "preparing" | "review" | "running" | "done";

export function useWalletSweep(wallets: BatchWalletView[], onLog?: LogFn) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<SweepMode>("dust");
  const [destination, setDestination] = useState("");
  const [phase, setPhase] = useState<SweepPhase>("idle");
  const [plan, setPlan] = useState<SweepPlan | null>(null);
  const [legs, setLegs] = useState<SweepLegState[]>([]);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  /** Defaults to the connected wallet's address until the user overrides it. */
  const effectiveDestination = destination.trim() || (publicKey ? publicKey.toBase58() : "");

  const destinationError = useMemo(() => {
    if (!effectiveDestination) return null;
    try {
      validateDestination(
        effectiveDestination,
        wallets.filter((w) => selectedIds.includes(w.id)).map((w) => w.publicKey)
      );
      return null;
    } catch (err) {
      return humanizeError(err);
    }
  }, [effectiveDestination, wallets, selectedIds]);

  const toggleWallet = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(wallets.slice(0, MAX_SWEEP_WALLETS).map((w) => w.id));
  }, [wallets]);

  const clearSelection = useCallback(() => setSelectedIds([]), []);
  const dismissError = useCallback(() => setError(null), []);

  const reset = useCallback(() => {
    setPhase("idle");
    setPlan(null);
    setLegs([]);
    setError(null);
  }, []);

  const cancelReview = useCallback(() => {
    if (phase !== "review") return;
    setPhase("idle");
    setPlan(null);
  }, [phase]);

  /** Step 1: read balances + the network's rent-exempt minimum, gate every wallet. Sends nothing. */
  const prepare = useCallback(async () => {
    if (phase !== "idle") return;
    if (destinationError || !effectiveDestination) return;

    const pool: SweepWalletInput[] = wallets
      .filter((w) => selectedIds.includes(w.id))
      .map(({ id, label, publicKey: pk }) => ({ id, label, publicKey: pk }));

    setPhase("preparing");
    setError(null);
    try {
      const nextPlan = await prepareSweep(connection, {
        destination: effectiveDestination,
        mode,
        wallets: pool,
        log: onLogRef.current,
      });
      setPlan(nextPlan);
      setPhase("review");
    } catch (err) {
      setPhase("idle");
      setError(humanizeError(err));
    }
  }, [phase, destinationError, effectiveDestination, wallets, selectedIds, connection, mode]);

  /** Step 2: sign locally + broadcast every cleared leg. */
  const confirm = useCallback(async () => {
    if (phase !== "review" || !plan) return;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLegs(initialSweepLegStates(plan));
    setPhase("running");
    setError(null);

    try {
      await executeSweep(connection, plan, {
        resolveKeypair: getBurnerKeypair,
        onLeg: (leg) => setLegs((prev) => prev.map((l) => (l.walletId === leg.walletId ? leg : l))),
        signal: ctrl.signal,
        log: onLogRef.current,
      });
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      abortRef.current = null;
      setPhase("done");
    }
  }, [phase, plan, connection]);

  /** Stops legs that haven't broadcast yet. Anything already sent can't be recalled. */
  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const actions = useMemo(
    () => ({ toggleWallet, selectAll, clearSelection, prepare, confirm, abort, cancelReview, reset, dismissError }),
    [toggleWallet, selectAll, clearSelection, prepare, confirm, abort, cancelReview, reset, dismissError]
  );

  return {
    selectedIds,
    mode,
    setMode,
    destination,
    setDestination,
    effectiveDestination,
    destinationError,
    phase,
    plan,
    legs,
    error,
    actions,
  };
}

export type WalletSweepController = ReturnType<typeof useWalletSweep>;
