-- ============================================================
-- Jobless Intel Terminal — Supabase schema
-- Run this in the Supabase SQL editor (or via the CLI) once.
-- ============================================================

-- 1. Primary Users Table
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sol_wallet_address TEXT UNIQUE,
  x_handle TEXT,
  x_avatar_url TEXT,
  custom_username TEXT UNIQUE,
  referred_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Execution Presets Table (P1, P2, P3 Fast Trading Configurations)
CREATE TABLE IF NOT EXISTS public.user_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  preset_name TEXT NOT NULL,
  buy_slippage NUMERIC DEFAULT 10,
  sell_slippage NUMERIC DEFAULT 10,
  priority_fee_sol NUMERIC DEFAULT 0.001,
  anti_mev_level TEXT DEFAULT 'REDUCED',
  CONSTRAINT unique_user_preset UNIQUE (user_id, preset_name)
);

-- 3. Wallet Tracking Table
CREATE TABLE IF NOT EXISTS public.tracked_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_address TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Referral Stats Table
CREATE TABLE IF NOT EXISTS public.referral_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  referral_code TEXT UNIQUE NOT NULL,
  total_referred_users INT DEFAULT 0,
  total_earnings_sol NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. User Watchlists Table (Token Contract Addresses)
CREATE TABLE IF NOT EXISTS public.user_watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_mint TEXT NOT NULL,
  symbol TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unique_user_watchlist_token UNIQUE (user_id, token_mint)
);

-- 6. Token Alert Preferences
CREATE TABLE IF NOT EXISTS public.token_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_mint TEXT NOT NULL,
  target_price_usd NUMERIC,
  target_market_cap NUMERIC,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. User Custom Layouts & Workspace Preferences
CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  layout_config JSONB DEFAULT '{}'::jsonb,
  chart_indicators JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Historical Trade Logs & PnL Tracking
CREATE TABLE IF NOT EXISTS public.trade_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_mint TEXT NOT NULL,
  trade_type TEXT CHECK (trade_type IN ('BUY', 'SELL')),
  amount_sol NUMERIC,
  amount_tokens NUMERIC,
  signature TEXT UNIQUE,
  realized_pnl_sol NUMERIC DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Sign-In-With-Solana nonces. NOT covered by the RLS policies below on
-- purpose — this table has zero user-facing policies, so anon/authenticated
-- roles get no access to it at all. Only the service-role key (used
-- exclusively server-side, in app/api/auth/*) can touch it. A nonce is a
-- short-lived random challenge, not sensitive user data, so it doesn't need
-- per-user RLS — it needs to be *unreachable* from the browser entirely.
CREATE TABLE IF NOT EXISTS public.auth_nonces (
  wallet_address TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Enable RLS across all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.token_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_nonces ENABLE ROW LEVEL SECURITY;
-- (auth_nonces intentionally gets no CREATE POLICY at all — see comment above)

-- 1. Complete RLS Policies for all tables
CREATE POLICY "Users can manage own profile" ON public.users FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can manage own presets" ON public.user_presets FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage tracked wallets" ON public.tracked_wallets FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view own referral stats" ON public.referral_stats FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage watchlists" ON public.user_watchlists FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage token alerts" ON public.token_alerts FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage user preferences" ON public.user_preferences FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can manage trade history" ON public.trade_history FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- 2. SIWS Mapping Helper Function (Maps authenticated Supabase session to Solana wallet address)
-- SECURITY DEFINER is safe here specifically because the function body only
-- ever writes auth.uid() (taken from the caller's own JWT) as the row id —
-- it can't be called to write a different user's id. Ownership of the
-- wallet address itself is proven separately, server-side, in
-- app/api/auth/link-wallet before this function is ever called (see
-- lib/wallet-auth.ts) — this function alone does NOT verify wallet
-- ownership, it just persists a link that's already been proven.
CREATE OR REPLACE FUNCTION public.link_solana_wallet(wallet_addr TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO public.users (id, sol_wallet_address)
  VALUES (auth.uid(), wallet_addr)
  ON CONFLICT (id) DO UPDATE
  SET sol_wallet_address = EXCLUDED.sol_wallet_address;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- NOTE — known limitation, not yet handled: sol_wallet_address is UNIQUE
-- across the whole table, so if a wallet is already linked to one
-- anonymous identity (browser A) and you try to link the same wallet from
-- a second anonymous identity (browser B), this INSERT will fail on the
-- unique constraint rather than merging the two accounts. There's no
-- cross-device account recovery/merge flow built yet — each browser's
-- anonymous session is a separate identity until you build one. The app
-- surfaces this as an explicit error rather than silently failing.

-- ============================================================
-- 10. Holder Distribution & Bundle Analysis — snapshot cache
-- ============================================================
-- Not user-owned data: it's a shared, public-good cache of a heuristic
-- computed from public on-chain data (see lib/holder-analysis.ts), keyed
-- only by mint. Caching it server-side means two users looking at the
-- same token within the TTL window don't each trigger a fresh
-- getSignaturesForAddress trace across ~15 wallets against a rate-limited
-- RPC. `analysis` stores the full HolderAnalysis JSON as returned by
-- fetchHolderAnalysis(); app/api/v1/holders/route.ts is the only writer.
CREATE TABLE IF NOT EXISTS public.token_holder_snapshots (
  token_mint TEXT PRIMARY KEY,
  analysis JSONB NOT NULL,
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE public.token_holder_snapshots ENABLE ROW LEVEL SECURITY;

-- Intentionally open, not auth.uid()-scoped like the tables above: this
-- is a public cache of public data, not anyone's private information, so
-- there's no user to scope it to. The route re-derives and overwrites a
-- given mint's row whenever it's stale (see CACHE_TTL_MS in the route),
-- so a bad write just gets replaced on the next fetch rather than
-- persisting.
CREATE POLICY "Anyone can read holder snapshots" ON public.token_holder_snapshots
  FOR SELECT USING (true);
CREATE POLICY "Anyone can write holder snapshots" ON public.token_holder_snapshots
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can refresh holder snapshots" ON public.token_holder_snapshots
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- 11. Smart Money & KOL Tracker
-- ============================================================
-- Tagged wallets, both curated (global, user_id IS NULL — populated by
-- your team via lib/smart-money.ts's seedCuratedWallet, NOT pre-seeded
-- with placeholder addresses here) and personal (a user's own tags,
-- user_id = auth.uid()). One table serves both because the read side
-- (lib/smart-money.ts's fetchSmartMoneyWallets) always wants "curated ∪
-- mine" in a single query.
CREATE TABLE IF NOT EXISTS public.smart_money_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE, -- NULL = curated/global
  address TEXT NOT NULL,
  label TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('kol', 'smart_money', 'whale')) DEFAULT 'smart_money',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unique_owner_address UNIQUE (user_id, address)
);

ALTER TABLE public.smart_money_wallets ENABLE ROW LEVEL SECURITY;

-- Read: curated rows are visible to everyone; personal rows only to their
-- owner. Write: only ever your own rows — curated rows (user_id NULL)
-- can't be inserted/edited/deleted from the client at all, since
-- `auth.uid() = user_id` can never match NULL. Seeding the curated list
-- is intentionally a service-role-only action (see the comment on
-- seedCuratedWallet in lib/smart-money.ts), not something any signed-in
-- user can do to everyone else's feed.
CREATE POLICY "Read curated or own smart money wallets" ON public.smart_money_wallets
  FOR SELECT USING (user_id IS NULL OR auth.uid() = user_id);
CREATE POLICY "Manage own smart money wallets" ON public.smart_money_wallets
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Update own smart money wallets" ON public.smart_money_wallets
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own smart money wallets" ON public.smart_money_wallets
  FOR DELETE USING (auth.uid() = user_id);

-- Cached win-rate/realized-PnL reads for the Smart Money feed's badges —
-- same "public cache of public on-chain data" shape and reasoning as
-- token_holder_snapshots above (see app/api/v1/smart-money/winrate).
CREATE TABLE IF NOT EXISTS public.wallet_win_rate_snapshots (
  wallet_address TEXT PRIMARY KEY,
  win_rate_pct NUMERIC NOT NULL DEFAULT 0,
  total_realized_sol NUMERIC NOT NULL DEFAULT 0,
  trades_scanned INT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wallet_win_rate_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read win rate snapshots" ON public.wallet_win_rate_snapshots
  FOR SELECT USING (true);
CREATE POLICY "Anyone can write win rate snapshots" ON public.wallet_win_rate_snapshots
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can refresh win rate snapshots" ON public.wallet_win_rate_snapshots
  FOR UPDATE USING (true) WITH CHECK (true);

-- Smart Money filter preferences (toggle mode + tier filters) ride along
-- on the existing per-user preferences row rather than getting their own
-- table — see lib/smart-money.ts's saveSmartMoneyPrefs, and note this
-- column is already covered by the "Users can manage user preferences"
-- policy declared above, so no new policy is needed for it.
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS smart_money_config JSONB DEFAULT '{}'::jsonb;

-- ============================================================
-- 12. Automated TP/SL & Trailing Stop Engine
-- ============================================================
-- Source of truth for a user's *desired* risk rules per open position, so
-- the panel shows the same active orders after closing the browser and
-- coming back — the rules survive, not an execution guarantee. This row
-- is NOT itself a server-side executor: fixed take-profit/stop-loss are
-- additionally filed as real on-chain Jupiter Trigger orders (filled by
-- Jupiter's keeper network independent of this table), while a
-- trailing-stop row is only actively enforced while
-- lib/tpsl-engine.ts's monitor is running in a browser tab, because its
-- stop price has no fixed value to pre-file on-chain — see the
-- module-level comment in lib/tpsl-engine.ts for the full reasoning.
CREATE TABLE IF NOT EXISTS public.user_tpsl_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL, -- connected wallet OR a burner's public key (lib/burner-vault.ts); never a secret key
  signer_id TEXT NOT NULL DEFAULT 'wallet-adapter', -- 'wallet-adapter' or a burner id, resolved client-side only
  chain TEXT NOT NULL DEFAULT 'solana',
  token_mint TEXT NOT NULL,
  token_symbol TEXT,
  token_amount NUMERIC NOT NULL CHECK (token_amount > 0), -- UI units exited when this rule fires
  entry_price_usd NUMERIC NOT NULL CHECK (entry_price_usd > 0),
  order_kind TEXT NOT NULL CHECK (order_kind IN ('take-profit', 'stop-loss', 'trailing-stop')),
  target_pct NUMERIC, -- take-profit (positive) / stop-loss (negative) trigger, % from entry
  trail_percent NUMERIC, -- trailing-stop only: trail width below the running peak, %
  high_water_mark_usd NUMERIC, -- trailing-stop only: ratchets up as price makes new highs
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'cancelled', 'error')),
  trigger_tx_signature TEXT,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  triggered_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT tpsl_order_shape CHECK (
    (order_kind IN ('take-profit', 'stop-loss') AND target_pct IS NOT NULL AND trail_percent IS NULL)
    OR
    (order_kind = 'trailing-stop' AND trail_percent IS NOT NULL AND target_pct IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tpsl_orders_user_active
  ON public.user_tpsl_orders (user_id, status)
  WHERE status = 'active';

ALTER TABLE public.user_tpsl_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own tpsl orders" ON public.user_tpsl_orders
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 13. SnipeX Creator Scorecard — deployer audit cache
-- ============================================================
-- Same "public cache of public on-chain data" shape as
-- token_holder_snapshots / wallet_win_rate_snapshots above: a creator's
-- launch history is public information, not any one user's private data,
-- so this is keyed only by wallet address with no user scoping. See
-- lib/creator-audit.ts for what `audit` contains and its heuristic
-- limitations (RUG_LIKELY is a pattern match, not a fraud determination).
CREATE TABLE IF NOT EXISTS public.creator_audits (
  creator_address TEXT PRIMARY KEY,
  audit JSONB NOT NULL,
  fetched_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE public.creator_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read creator audits" ON public.creator_audits
  FOR SELECT USING (true);
CREATE POLICY "Anyone can write creator audits" ON public.creator_audits
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can refresh creator audits" ON public.creator_audits
  FOR UPDATE USING (true) WITH CHECK (true);

-- ============================================================
-- 14. SnipeX Feed — saved alpha sources (accounts/channels to parse)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.snipe_x_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  handle TEXT NOT NULL, -- e.g. an X handle or channel id the feed ingests
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT unique_user_source UNIQUE (user_id, handle)
);

ALTER TABLE public.snipe_x_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own snipe-x sources" ON public.snipe_x_sources
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 15. Trade Stats & Community Leaderboard (Slice 9)
-- ============================================================
-- One row per user, aggregated from the wallet's OWN on-chain history.
--
-- Trust model — read this before loosening any policy below:
--   * Leaderboards get gamed the moment a client can write its own score.
--     So there is deliberately NO insert/update/delete policy on this table
--     and write privileges are revoked from anon/authenticated. The only
--     writer is app/api/v1/leaderboard/sync (service role), which re-derives
--     every number from the SIWS-linked wallet's transaction history via
--     lib/closed-positions.ts + lib/trade-stats.ts. The client never
--     supplies a wallet address or a stat.
--   * A user sees only their own row directly (policy below). Everyone
--     else's numbers are reachable solely through get_leaderboard(), which
--     returns opted-in rows and a display name — never user ids or full
--     wallet addresses.
--   * Opt-in defaults to FALSE: nobody's PnL becomes public until they flip
--     it themselves (set_leaderboard_opt_in).
--
-- Known limits (also stated in the UI/README): stats cover the scanned
-- signature window, not "all time"; volume can be inflated by wash-trading
-- between wallets someone controls, which is why ranking never uses volume
-- alone as a skill signal and cost-basis/size floors exist in
-- lib/closed-positions.ts.
CREATE TABLE IF NOT EXISTS public.user_trade_stats (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  trades_closed INT NOT NULL DEFAULT 0 CHECK (trades_closed >= 0),
  wins INT NOT NULL DEFAULT 0 CHECK (wins >= 0),
  win_rate_pct NUMERIC NOT NULL DEFAULT 0 CHECK (win_rate_pct BETWEEN 0 AND 100),
  total_volume_sol NUMERIC NOT NULL DEFAULT 0 CHECK (total_volume_sol >= 0),
  total_realized_sol NUMERIC NOT NULL DEFAULT 0,
  best_roi_pct NUMERIC,           -- best single eligible closed trade; NULL until one exists
  best_roi_mint TEXT,
  best_roi_signature TEXT,        -- the sell tx, so the claim is checkable on any explorer
  signatures_scanned INT NOT NULL DEFAULT 0,
  leaderboard_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_stats_board
  ON public.user_trade_stats (total_realized_sol DESC)
  WHERE leaderboard_opt_in AND synced_at IS NOT NULL;

ALTER TABLE public.user_trade_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own trade stats" ON public.user_trade_stats
  FOR SELECT USING (auth.uid() = user_id);
-- (no INSERT / UPDATE / DELETE policy on purpose — see trust model above)

REVOKE INSERT, UPDATE, DELETE ON public.user_trade_stats FROM anon, authenticated;

-- The only thing a user may change about their row: whether it's listed.
-- SECURITY DEFINER is safe because the body only ever touches auth.uid()'s
-- own row and only the opt-in flag. The FK to public.users means this
-- fails for a session that hasn't linked a wallet via SIWS yet.
CREATE OR REPLACE FUNCTION public.set_leaderboard_opt_in(p_opt_in BOOLEAN)
RETURNS VOID AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  INSERT INTO public.user_trade_stats (user_id, leaderboard_opt_in)
  VALUES (auth.uid(), p_opt_in)
  ON CONFLICT (user_id) DO UPDATE SET leaderboard_opt_in = EXCLUDED.leaderboard_opt_in;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.set_leaderboard_opt_in(BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_leaderboard_opt_in(BOOLEAN) TO authenticated;

-- Public leaderboard. Sort keys are whitelisted through CASE (never
-- interpolated). Minimum-trade floors keep one lucky trade from topping
-- the win-rate / ROI boards. `is_you` lets the client highlight the
-- caller's own row without exposing anyone's user id.
CREATE OR REPLACE FUNCTION public.get_leaderboard(p_sort TEXT DEFAULT 'pnl', p_limit INT DEFAULT 50)
RETURNS TABLE (
  place BIGINT,
  display_name TEXT,
  trades_closed INT,
  win_rate_pct NUMERIC,
  total_volume_sol NUMERIC,
  total_realized_sol NUMERIC,
  best_roi_pct NUMERIC,
  synced_at TIMESTAMP WITH TIME ZONE,
  is_you BOOLEAN
) AS $$
  SELECT
    row_number() OVER (
      ORDER BY
        CASE p_sort
          WHEN 'roi' THEN s.best_roi_pct
          WHEN 'winrate' THEN s.win_rate_pct
          WHEN 'volume' THEN s.total_volume_sol
          ELSE s.total_realized_sol
        END DESC NULLS LAST,
        s.trades_closed DESC
    ) AS place,
    left(COALESCE(
      NULLIF(btrim(u.custom_username), ''),
      NULLIF(btrim(u.x_handle), ''),
      left(u.sol_wallet_address, 4) || '…' || right(u.sol_wallet_address, 4)
    ), 24) AS display_name,
    s.trades_closed,
    s.win_rate_pct,
    s.total_volume_sol,
    s.total_realized_sol,
    s.best_roi_pct,
    s.synced_at,
    COALESCE(s.user_id = auth.uid(), FALSE) AS is_you
  FROM public.user_trade_stats s
  JOIN public.users u ON u.id = s.user_id
  WHERE s.leaderboard_opt_in
    AND s.synced_at IS NOT NULL
    AND s.trades_closed >= CASE WHEN p_sort = 'winrate' THEN 5 ELSE 3 END
  ORDER BY place
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_leaderboard(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leaderboard(TEXT, INT) TO anon, authenticated;
