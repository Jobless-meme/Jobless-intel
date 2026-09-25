"use client";

import { useLeaderboard, type LeaderboardSort } from "@/hooks/useLeaderboard";
import { formatRoi, formatSol } from "@/lib/pnl-card-renderer";

const SORTS: { id: LeaderboardSort; label: string; hint: string }[] = [
  { id: "pnl", label: "Profit", hint: "Total realized SOL" },
  { id: "roi", label: "Best ROI", hint: "Best single closed trade" },
  { id: "winrate", label: "Win rate", hint: "Min. 5 closed trades" },
  { id: "volume", label: "Volume", hint: "SOL traded" },
];

function primary(sort: LeaderboardSort, r: { totalRealizedSol: number; bestRoiPct: number | null; winRatePct: number; totalVolumeSol: number }) {
  switch (sort) {
    case "roi":
      return r.bestRoiPct == null ? "—" : formatRoi(r.bestRoiPct);
    case "winrate":
      return `${r.winRatePct.toFixed(0)}%`;
    case "volume":
      return `${formatSol(r.totalVolumeSol)} SOL`;
    default:
      return `${formatSol(r.totalRealizedSol, true)} SOL`;
  }
}

export default function LeaderboardPanel() {
  const { sort, setSort, rows, me, signedIn, loading, syncing, error, note, refresh, syncMine, setOptIn } = useLeaderboard("pnl");
  const hint = SORTS.find((s) => s.id === sort)?.hint;

  return (
    <div className="glass-panel rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-[var(--text-dim)]">COMMUNITY LEADERBOARD</h3>
        <button type="button" className="lx-btn !px-3 !py-1.5" disabled={loading} onClick={() => void refresh()}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Your stats */}
      <div className="mb-3 rounded-xl border border-[var(--border)] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-[var(--text)]">Your stats</span>
          <button type="button" className="lx-btn !px-3 !py-1.5" disabled={syncing || !signedIn} onClick={() => void syncMine()}>
            {syncing ? "Reading chain…" : me?.syncedAt ? "Re-sync" : "Sync stats"}
          </button>
        </div>

        {!signedIn ? (
          <p className="mt-2 font-mono text-[10px] text-[var(--text-dim)]">
            Sign in with your wallet (Settings → Cloud Sync) to sync stats and join the board.
          </p>
        ) : me?.syncedAt ? (
          <>
            <div className="mt-2 grid grid-cols-4 gap-2 font-mono text-[10px]">
              {[
                ["PnL", `${formatSol(me.totalRealizedSol, true)}`],
                ["Win", `${me.winRatePct.toFixed(0)}%`],
                ["Best", me.bestRoiPct == null ? "—" : formatRoi(me.bestRoiPct)],
                ["Trades", String(me.tradesClosed)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg bg-[var(--bg-elevated)] px-2 py-1.5">
                  <div className="text-[var(--text-dim)]">{k}</div>
                  <div className="text-xs text-[var(--text)]">{v}</div>
                </div>
              ))}
            </div>
            <label className="mt-3 flex items-center justify-between gap-3">
              <span>
                <span className="block font-mono text-xs text-[var(--text)]">List me on the leaderboard</span>
                <span className="block font-mono text-[10px] text-[var(--text-dim)]">
                  Shows your name, PnL, win rate and volume publicly. Off by default.
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={me.leaderboardOptIn}
                onClick={() => void setOptIn(!me.leaderboardOptIn)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  me.leaderboardOptIn ? "bg-[var(--accent)]" : "bg-[var(--bg-elevated-strong)]"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    me.leaderboardOptIn ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </label>
          </>
        ) : (
          <p className="mt-2 font-mono text-[10px] text-[var(--text-dim)]">
            Not synced yet. Stats are computed on the server from your verified wallet&apos;s on-chain trades — they can&apos;t be typed in.
          </p>
        )}
      </div>

      {/* Sort tabs */}
      <div className="mb-2 flex gap-2 overflow-x-auto thin-scroll">
        {SORTS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSort(s.id)}
            className={`shrink-0 rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${
              sort === s.id
                ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-bright)]"
                : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-elevated)]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="mb-2 font-mono text-[10px] text-[var(--text-dim)]">{hint}</p>

      {error && <p className="mb-2 font-mono text-[10px] text-[var(--danger)]">{error}</p>}
      {note && <p className="mb-2 font-mono text-[10px] text-[var(--text-dim)]">{note}</p>}

      {rows.length === 0 && !loading ? (
        <p className="font-mono text-xs text-[var(--text-dim)]">
          Nobody is listed yet — sync your stats and switch on &quot;List me&quot; to be first.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li
              key={`${r.place}:${r.displayName}`}
              className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2 ${
                r.isYou ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)]"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-6 shrink-0 text-center font-mono text-xs text-[var(--text-dim)]">{r.place}</span>
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-[var(--text)]">
                    {r.displayName}
                    {r.isYou && <span className="ml-1.5 text-[var(--accent-bright)]">you</span>}
                  </div>
                  <div className="font-mono text-[10px] text-[var(--text-dim)]">
                    {r.tradesClosed} trades · {r.winRatePct.toFixed(0)}% win
                  </div>
                </div>
              </div>
              <span
                className="shrink-0 font-mono text-xs font-semibold"
                style={{ color: sort === "pnl" && r.totalRealizedSol < 0 ? "var(--danger)" : "var(--success)" }}
              >
                {primary(sort, r)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 font-mono text-[9px] leading-tight text-[var(--text-dim)]">
        Computed from each wallet&apos;s recent on-chain history (not all-time), using only the wallet verified at sign-in. Very small or
        partial-history trades are excluded. Volume can be padded by trading between your own wallets — that&apos;s why profit is the default
        ranking.
      </p>
    </div>
  );
}
