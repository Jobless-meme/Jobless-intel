"use client";

import { useCallback, useMemo, useState } from "react";
import { usePumpNewTokens } from "@/lib/pump-portal";
import { parseAlphaMentions, type ParsedAlphaMention } from "@/lib/snipe-x-parser";
import type { CreatorAudit, CreatorRiskLevel } from "@/lib/creator-audit";
import { submitAutomatedTradeOrder, type WalletSigner } from "@/lib/agents-engine";
import { getTradePresets } from "@/lib/trade-presets";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function shortAddr(addr: string) {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function riskColor(level: CreatorRiskLevel): string {
  switch (level) {
    case "LOW":
      return "var(--success)";
    case "MEDIUM":
      return "var(--accent-bright)";
    case "HIGH":
    case "RUG_LIKELY":
      return "var(--danger)";
  }
}

/** One detected alpha mention, tracked through: parsed -> audited -> sniped. */
interface FeedItem {
  id: string;
  source: "pasted" | "pumpportal";
  mint: string;
  creator: string | null;
  contextTags: string[];
  createdAt: number;
  audit: CreatorAudit | null;
  auditLoading: boolean;
  auditError: string | null;
  snipeStatus: "idle" | "sending" | "sent" | "failed";
  snipeError: string | null;
  snipeSignature: string | null;
}

function CreatorScorecard({ audit, loading, error }: { audit: CreatorAudit | null; loading: boolean; error: string | null }) {
  if (loading) return <span className="font-mono text-[10px] text-[var(--text-dim)]">auditing deployer...</span>;
  if (error) return <span className="font-mono text-[10px] text-[var(--danger)]">audit failed</span>;
  if (!audit) return null;

  const color = riskColor(audit.riskLevel);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
        style={{ color, background: `${color}1a`, border: `1px solid ${color}40` }}
      >
        {audit.riskLevel.replace("_", " ")}
      </span>
      <span className="font-mono text-[9px] text-[var(--text-dim)]">
        {audit.totalLaunches} prior launch{audit.totalLaunches === 1 ? "" : "es"} · {audit.completionRatePct}%
        completed
        {audit.abandonedCount > 0 ? ` · ${audit.abandonedCount} abandoned` : ""}
        {audit.partial ? " · partial history" : ""}
      </span>
    </div>
  );
}

export default function SnipeXFeedPanel({
  wallet,
  onLog,
}: {
  wallet: WalletSigner | null;
  onLog?: (line: string) => void;
}) {
  const [pasteText, setPasteText] = useState("");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Real, live half of the feed: pump.fun creations already carry a known
  // creator wallet, so these skip straight to "audit this deployer" with
  // no regex step needed. The paste box below covers the "social text
  // with a CA buried in it" half of SnipeX — this project has no live
  // X/Telegram ingestion wired up (no such connector available here), so
  // that source is manual-paste for now; swap in a real stream by
  // pushing parsed text through parseAlphaMentions the same way onPaste does.
  const pumpTokens = usePumpNewTokens(20);

  const pumpItems: FeedItem[] = useMemo(
    () =>
      pumpTokens.map((t) => ({
        id: `pp_${t.mint}`,
        source: "pumpportal" as const,
        mint: t.mint,
        creator: t.creator,
        contextTags: [],
        createdAt: t.createdAt,
        audit: null,
        auditLoading: false,
        auditError: null,
        snipeStatus: "idle" as const,
        snipeError: null,
        snipeSignature: null,
      })),
    [pumpTokens]
  );

  const allItems = useMemo(
    () => [...items, ...pumpItems].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60),
    [items, pumpItems]
  );

  function patchItem(id: string, patch: Partial<FeedItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function ingestPastedText() {
    setError(null);
    const mentions: ParsedAlphaMention[] = parseAlphaMentions(pasteText);
    const plausible = mentions.filter((m) => m.plausible);
    if (plausible.length === 0) {
      setError("No plausible Solana contract addresses found in that text.");
      return;
    }
    const now = Date.now();
    const next: FeedItem[] = plausible.map((m, i) => ({
      id: `paste_${now}_${i}_${m.mint.slice(0, 6)}`,
      source: "pasted",
      mint: m.mint,
      creator: null, // unknown until an on-chain lookup — creator audit needs the deployer wallet, which pasted text alone doesn't carry
      contextTags: m.contextTags,
      createdAt: now,
      audit: null,
      auditLoading: false,
      auditError: null,
      snipeStatus: "idle",
      snipeError: null,
      snipeSignature: null,
    }));
    setItems((prev) => [...next, ...prev].slice(0, 200));
    setPasteText("");
  }

  const runAudit = useCallback(async (item: FeedItem) => {
    if (!item.creator) return; // pasted mentions without a known deployer can't be audited — see ingestPastedText note
    const isPumpItem = item.source === "pumpportal";
    if (!isPumpItem) patchItem(item.id, { auditLoading: true, auditError: null });

    try {
      const res = await fetch(`/api/v1/creator-audit?creator=${item.creator}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Audit failed");
      const audit = data.audit as CreatorAudit;
      if (isPumpItem) {
        setItems((prev) => {
          const already = prev.find((p) => p.id === item.id);
          const base = already ?? item;
          return [{ ...base, audit, auditLoading: false, auditError: null }, ...prev.filter((p) => p.id !== item.id)];
        });
      } else {
        patchItem(item.id, { audit, auditLoading: false });
      }
    } catch (err: any) {
      if (isPumpItem) {
        setItems((prev) => [
          { ...item, auditLoading: false, auditError: err?.message ?? "Audit failed" },
          ...prev.filter((p) => p.id !== item.id),
        ]);
      } else {
        patchItem(item.id, { auditLoading: false, auditError: err?.message ?? "Audit failed" });
      }
    }
  }, []);

  async function snipe(item: FeedItem) {
    if (!wallet) {
      setError("Connect a wallet before sniping.");
      return;
    }
    const isPumpItem = item.source === "pumpportal";
    const setStatus = (patch: Partial<FeedItem>) =>
      isPumpItem
        ? setItems((prev) => {
            const already = prev.find((p) => p.id === item.id);
            const base = already ?? item;
            return [{ ...base, ...patch }, ...prev.filter((p) => p.id !== item.id)];
          })
        : patchItem(item.id, patch);

    setStatus({ snipeStatus: "sending", snipeError: null });
    try {
      const amountSol = getActiveQuickBuyAmountSafe();
      const { signature } = await submitAutomatedTradeOrder(
        {
          orderType: "swap",
          chain: "solana",
          inputMint: SOL_MINT,
          outputMint: item.mint,
          amount: String(Math.floor(amountSol * 1e9)), // lamports
          wallet,
        },
        onLog
      );
      setStatus({ snipeStatus: "sent", snipeSignature: signature });
    } catch (err: any) {
      setStatus({ snipeStatus: "failed", snipeError: err?.message ?? "Snipe failed" });
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          SNIPEX ALPHA INTAKE
        </h3>
        <p className="mb-2 font-mono text-[10px] text-[var(--text-dim)]">
          Paste a tweet/message and SnipeX pulls any Solana contract address out of it. Live pump.fun
          launches below are ingested automatically.
        </p>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="Paste alpha text here — e.g. &quot;LFG this is early 9xk...pump early gem&quot;"
          rows={3}
          className="w-full resize-none rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--text)]"
        />
        <div className="mt-2 flex items-center justify-between">
          <button type="button" onClick={ingestPastedText} className="lx-btn">
            Parse Contract Addresses
          </button>
          {error && <span className="font-mono text-[10px] text-[var(--danger)]">{error}</span>}
        </div>
      </div>

      <div className="glass-panel rounded-2xl p-4">
        <h3 className="mb-3 font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">
          LIVE FEED — {allItems.length}
        </h3>
        <div className="flex flex-col gap-2">
          {allItems.length === 0 && (
            <p className="font-mono text-xs text-[var(--text-dim)]">Nothing parsed yet — paste some alpha above.</p>
          )}
          {allItems.map((item) => (
            <div key={item.id} className="glass-panel rounded-xl px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs text-[var(--text)]">{shortAddr(item.mint)}</span>
                    <span className="shrink-0 rounded-full bg-[var(--bg-elevated-strong)] px-1.5 py-0.5 font-mono text-[8px] text-[var(--text-dim)]">
                      {item.source === "pumpportal" ? "pump.fun live" : "pasted"}
                    </span>
                  </div>
                  {item.contextTags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.contextTags.map((t) => (
                        <span key={t} className="font-mono text-[9px] text-[var(--text-dim)]">
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.creator ? (
                    <CreatorScorecard audit={item.audit} loading={item.auditLoading} error={item.auditError} />
                  ) : (
                    <span className="mt-1 block font-mono text-[9px] text-[var(--text-dim)]">
                      deployer unknown — audit unavailable for a pasted mention
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {item.creator && !item.audit && !item.auditLoading && (
                    <button
                      type="button"
                      onClick={() => runAudit(item)}
                      className="font-mono text-[9px] text-[var(--text-dim)] underline decoration-dotted hover:text-[var(--text)]"
                    >
                      audit creator
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={item.snipeStatus === "sending" || !wallet}
                    onClick={() => snipe(item)}
                    className={`rounded-full px-3 py-1.5 font-mono text-[11px] font-semibold disabled:opacity-50 ${
                      item.snipeStatus === "sent"
                        ? "bg-[var(--success)]/20 text-[var(--success)]"
                        : item.snipeStatus === "failed"
                          ? "bg-[var(--danger)]/20 text-[var(--danger)]"
                          : "bg-[var(--success)] text-black"
                    }`}
                  >
                    {item.snipeStatus === "sending"
                      ? "Sniping..."
                      : item.snipeStatus === "sent"
                        ? "Sniped ✓"
                        : item.snipeStatus === "failed"
                          ? "Retry"
                          : "Snipe"}
                  </button>
                </div>
              </div>
              {item.snipeError && <p className="mt-1 font-mono text-[9px] text-[var(--danger)]">{item.snipeError}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** getActiveQuickBuyAmount() is SSR-unsafe by contract (reads localStorage)
 * — this component is "use client" so it's fine, but guarded anyway since
 * it's called from an event handler that shouldn't throw the whole snipe
 * away over a storage read glitch. */
function getActiveQuickBuyAmountSafe(): number {
  try {
    const p = getTradePresets();
    return p.amounts[p.activeSlot];
  } catch {
    return 0.1;
  }
}
