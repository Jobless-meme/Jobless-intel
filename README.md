# Jobless Intel — Trading Terminal

A Next.js (App Router) mobile-first trading terminal shell for Jobless Intel:
crown-logo loader, three-way theme engine, faux candlestick chart with a
watermark, floating bottom nav, and the full nested Settings drawer
(Trade Settings, Wallet Manager, Security, Help & Support, About Us,
Preferences).

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000 — it's built mobile-first, so use your browser's
device toolbar (or a phone) to see it as intended; it also scales up cleanly
to desktop widths.

## Multi-Wallet Batch Trading

Settings → Trade Settings → Execution Bay → **Multi-Wallet Batch**.

- `lib/batch-trading.ts` — engine: allocation (equal / fixed / custom),
  pre-flight (parallel SOL/token balance reads + parallel Jupiter quotes,
  fee/rent safety reserve, price-impact guard), staggered/jittered timing,
  and per-wallet build → sign → broadcast → confirm.
- `lib/burner-vault.ts` — up to 10 local session wallets. The existing
  Copy-Trade key is adopted as wallet #1, so both features share one funded key.
- `hooks/useBatchTrading.ts` — persistent store + hook (selection, allocation
  mode, slippage/priority overrides, live run state). A batch keeps running
  if the sheet is closed.
- `components/BatchTradingModal.tsx` — mobile bottom sheet: control deck →
  review (nothing sent yet) → live per-wallet progress with signatures.

Keys never leave the browser: the engine route only receives public keys and
returns unsigned transactions; every leg is signed locally. Quotes in the
review step are advisory — each swap is rebuilt from a fresh server-side quote
at fire time. `MY_JUPITER_REFERRAL_FEE_ACCOUNT` must be set or the engine
builds no transactions (the batch will report that per wallet).

## Slice 9 — Viral PnL card + community leaderboard

- `lib/pnl-card-renderer.ts` — draws the 1200×675 dark-glass card directly on
  a `<canvas>` (no html-to-image dependency; the preview is the exact image
  you copy/download). Also: clipboard, download, X/Telegram intents, and the
  mobile share sheet with the image attached.
- `components/PnlShareModal.tsx` — bottom sheet with toggles to hide the
  wallet or the SOL amounts before posting.
- `lib/closed-positions.ts` + `hooks/useClosedTrades.ts` — closed trades
  derived (FIFO) from the wallet's own on-chain history via
  `lib/wallet-pnl.ts`, so keeper-filled TP/SL, manual and batch sells all
  show up. Scan is button-driven and shared across panels.
- `components/ClosedTradesPanel.tsx` — closed rows with **Share PnL**;
  mounted in the Execution Bay, and (filtered to one token) in the TP/SL deck,
  which also gets a **Share PnL** button for the live open position.
- `supabase/schema.sql` §15 — `user_trade_stats`, `get_leaderboard()`,
  `set_leaderboard_opt_in()`. **Run the new section in the SQL editor.**
- `app/api/v1/leaderboard/sync/route.ts` — the ONLY writer of
  `user_trade_stats`. Re-derives stats server-side from the SIWS-verified
  wallet's transactions; the browser can't write scores (no write policies,
  privileges revoked). 5-minute cooldown per user.
- `hooks/useLeaderboard.ts` + `components/LeaderboardPanel.tsx` — board
  (profit / best ROI / win rate / volume), your stats, and the opt-in switch
  (off by default).

Limits worth knowing: stats cover the recent scanned window (120 tx server
side, 150 client side), not all-time; SOL figures are net wallet movement
(fees/rent included); burner-wallet trades can be shared but aren't counted
(only the SIWS-verified wallet is provable); `?ref=` links are generated but
nothing captures them into `referred_by` yet. Set `SOLANA_RPC_URL` (or
`NEXT_PUBLIC_SOLANA_RPC_URL`) to a real provider — the sync route makes one
RPC call per transaction.

## What's wired up vs. stubbed

- **Real:** loader sequence, theme switching + `<meta name="theme-color">`
  sync, the whole settings navigation stack, toggles, tab switching, chart
  watermark, the live candlestick chart (`lib/chart-feed.ts`, polling
  GeckoTerminal's free public API every 30s), the live Trending list on
  Discover (`lib/trending.ts`, merged Solana + BSC, click a row to
  re-point the chart), real Solana + BSC wallet connect (Phantom/Solflare
  via `@solana/wallet-adapter-react`, MetaMask/injected via `wagmi`), the
  Portfolio tab (`lib/balances.ts` + `lib/prices.ts` — real on-chain
  balances × live USD price, no fabricated PnL), and the Automated
  Execution Bay (`app/api/v1/engine/feed/route.ts` +
  `lib/agents-engine.ts` + `components/ExecutionBay.tsx`) for swaps,
  limit/TP/SL/trailing-stop orders (Jupiter's on-chain Trigger program),
  DCA (Jupiter Recurring), BSC swaps via 0x's permit2 flow
  (`lib/permit2.ts` — allowance approval + EIP-712 signature splicing),
  and MEV-aware routing.
- **Real, free-tier, this pass:** the Trenches tab — live New/Almost
  Bonded feed from PumpPortal's free WebSocket (`lib/pump-portal.ts`),
  Migrated feed from GeckoTerminal's `new_pools` (Raydium-filtered); the
  Track tab — live per-wallet buy/sell feed via PumpPortal's
  `subscribeAccountTrade` (`components/TrackView.tsx`, pump.fun/Raydium
  activity only — it doesn't see Orca/Meteora/raw Jupiter routes, that
  needs a real indexer); the Copy tab — auto-copy trading via an explicit,
  user-funded local "session wallet" (`lib/copy-trading.ts` +
  `components/CopyView.tsx`) since browser-extension wallets can't sign
  without a popup and this repo won't hold custody server-side; RugCheck
  security badges (`lib/rugcheck.ts`) on Trenches cards; realized PnL via
  client-side `getSignaturesForAddress` + balance-delta parsing
  (`lib/wallet-pnl.ts`, exposed from Portfolio); Quick Buy presets
  (P1/P2/P3 + slippage + anti-MEV, `lib/trade-presets.ts`) wired to every
  one-tap Buy button, editable at Settings → Trade Settings → Quick Buy;
  the full Execution Bay (swaps/limit/TP/SL/trailing/DCA/multi-wallet) is
  still there, just moved to Settings → Trade Settings → Execution Bay
  now that Trenches owns the tab GMGN uses for it.
- **Deliberately not built — needs a paid provider or would violate a
  ToS, not just more code:** X/Twitter intelligence (no free real-time
  API, and scraping violates X's ToS); Rank/Top Callers/KOL leaderboards
  (needs a service indexing thousands of wallets' PnL, which public RPC
  can't do at that scale); full multi-indicator charting (MA/EMA/BOLL/SAR/
  MACD/KDJ/RSI overlays) and the PnL calendar/distribution/phishing-check
  sub-tabs — these are real, buildable work, just not done this pass;
  ask and I'll pick them up next.
- **Real risk, not a bug:** Copy tab's auto-execution uses a private key
  stored in browser localStorage. Anyone with access to that browser/
  device can drain whatever's in that session wallet. Only fund it with
  what you can afford to lose — same trade-off any hot-wallet sniper bot
  has, GMGN's own included.
- **Cosmetic only:** the crown logo, copy, and color theme itself — no
  claim of realness needed there, it's just branding.

## File map

```
app/
  layout.tsx      — fonts (Space Grotesk + JetBrains Mono), viewport meta
  page.tsx         — everything: theme engine, loader, chart, nav, settings
  globals.css      — theme CSS variables for the 3 backgrounds, shared utility classes
public/
  logo.png         — your crown mark, already dropped in
tailwind.config.ts — accent/glow colors, shimmer/breathe/drift/cascade keyframes
```

`page.tsx` is intentionally kept as one file per the brief — everything
(theme context, loader, chart, settings screens, nav) lives in there as
separate components you can freely split into `components/*.tsx` later.

## Notes on the design choices

- **Typography:** Space Grotesk for display/UI text, JetBrains Mono for
  every number, address, ticker, and label that reads as market data — the
  mono/display split is what makes it feel like a terminal rather than a
  generic app.
- **Cosmic theme:** the "flora" is abstracted as soft bioluminescent glow
  blobs (cyan / purple / orange) drifting slowly behind the UI, plus a
  faint starfield — deliberately restrained rather than literal plant
  illustrations, to keep the glass panels legible.
- **Wallet button:** `#solanaWalletBtn` has the pulsing cyan/purple hairline
  glow from the spec (`.hairline-glow` in `globals.css`).
- **Settings** is a single sliding drawer with an internal navigation
  stack (`Main → Trade Settings → …`), so back always pops one level and
  the whole thing can be closed from any depth.

## Next steps you'll likely want

1. Wire a real Solana wallet adapter into `#solanaWalletBtn`.
2. Replace `useFakeCandles` in `TerminalChart` with live OHLC data.
3. Split `page.tsx` into `components/` once you start extending individual
   screens — the structure is already componentized to make that a
   copy-paste job.
