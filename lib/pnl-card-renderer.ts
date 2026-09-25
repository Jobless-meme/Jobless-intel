/**
 * PnL share-card renderer.
 *
 * Draws the card straight onto a <canvas> instead of screenshotting a DOM
 * node (html-to-image & co.). Reasons, all practical:
 *   - the PNG you preview is byte-for-byte the PNG you copy/download/share;
 *   - no DOM cloning, so none of the Safari "first render is blank" /
 *     next/font embedding quirks;
 *   - zero new dependencies, and nothing about the trade leaves the browser.
 *
 * Browser-only (needs `document`). Everything except renderPnlCard() and the
 * clipboard/download/share helpers is pure and safe to unit-test.
 */

export const PNL_CARD_WIDTH = 1200;
export const PNL_CARD_HEIGHT = 675; // 16:9 — X / Telegram large-image ratio

export type PnlCardStatus = "closed" | "open";

export interface PnlCardData {
  symbol: string;
  /** closed = realized sale; open = live unrealized snapshot. */
  status: PnlCardStatus;
  priceUnit: "SOL" | "USD";
  entryPrice: number;
  /** Exit price for a closed trade, current price for an open one. */
  exitPrice: number;
  roiPct: number;
  pnlSol: number;
  costSol?: number;
  walletAddress?: string;
  /** Sell signature — printed short on the card so anyone can look it up. */
  txSignature?: string;
  /** true only when the numbers were derived from on-chain history. */
  onChainVerified?: boolean;
  referralCode?: string;
  /** Full link, printed (without protocol) on the card. */
  referralUrl?: string;
  closedAt?: number;
}

export interface PnlCardOptions {
  /** Backing-store multiplier (default 1.5 → 1800×1013). The logical layout stays 1200×675. */
  scale?: number;
  showWallet?: boolean;
  showAmounts?: boolean;
  logoUrl?: string;
}

export interface RenderedPnlCard {
  /** PNG — the only type every browser accepts on the clipboard. */
  blob: Blob;
  /** Re-encode the same pixels. PNG of this artwork is ~2–4 MB (gradients
   * don't compress); JPEG at 0.92 is ~10x smaller, which is what you want
   * for downloads and share sheets (X caps uploads at 5 MB). */
  encode: (type: "image/png" | "image/jpeg", quality?: number) => Promise<Blob>;
  /** object: URL for an <img> preview — caller must URL.revokeObjectURL it. */
  objectUrl: string;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Pure formatting helpers                                            */
/* ------------------------------------------------------------------ */

// Token symbols come from third-party metadata and are attacker-controlled
// (on-chain names can carry RTL overrides / zero-width chars for spoofing).
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeSymbol(raw: string, max = 14): string {
  const cleaned = (raw ?? "").replace(UNSAFE_TEXT, "").trim().replace(/^\$+/, "");
  return (cleaned || "TOKEN").slice(0, max).toUpperCase();
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  return addr.length > head + tail + 1 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

export function formatRoi(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  const abs = Math.abs(pct);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M%`;
  if (abs >= 1000) return `${sign}${Math.round(abs).toLocaleString("en-US")}%`;
  if (abs >= 100) return `${sign}${abs.toFixed(0)}%`;
  return `${sign}${abs.toFixed(1)}%`;
}

export function formatMultiple(pct: number): string | null {
  if (!Number.isFinite(pct) || pct < 100) return null;
  const x = 1 + pct / 100;
  return `${x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(1)}x`;
}

export function formatSol(sol: number, signed = false): string {
  if (!Number.isFinite(sol)) return "—";
  const sign = signed ? (sol > 0 ? "+" : sol < 0 ? "-" : "") : sol < 0 ? "-" : "";
  const abs = Math.abs(sol);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `${sign}${abs.toFixed(digits)}`;
}

/** Price with ~4 significant digits, no exponent notation for anything a
 * memecoin realistically trades at (0.000001235 rather than 1.235e-6). */
export function formatPrice(price: number, unit: "SOL" | "USD"): string {
  if (!Number.isFinite(price) || price <= 0) return "—";
  const prefix = unit === "USD" ? "$" : "";
  let body: string;
  if (price >= 1000) body = price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  else if (price >= 1) body = price.toFixed(3);
  else if (price < 1e-9) body = price.toExponential(2);
  else {
    const leadingZeros = -Math.floor(Math.log10(price)) - 1;
    body = price.toFixed(Math.min(leadingZeros + 4, 12)).replace(/0+$/, "");
  }
  return `${prefix}${body}`;
}

export type PnlTier = { label: string; color: string };

export function pnlTier(roiPct: number): PnlTier {
  if (roiPct >= 1000) return { label: "MOONSHOT", color: "#FF8800" };
  if (roiPct >= 300) return { label: "DIAMOND", color: "#22D3EE" };
  if (roiPct >= 100) return { label: "ALPHA", color: "#A78BFA" };
  if (roiPct >= 25) return { label: "SHARP", color: "#33E39A" };
  if (roiPct >= 0) return { label: "GREEN", color: "#33E39A" };
  if (roiPct > -50) return { label: "DOWN BAD", color: "#FF8FA3" };
  return { label: "REKT", color: "#FF4D6D" };
}

/* ------------------------------------------------------------------ */
/* Canvas plumbing                                                     */
/* ------------------------------------------------------------------ */

const GREEN = "#33E39A";
const RED = "#FF4D6D";
const CYAN = "#22D3EE";
const PURPLE = "#7C3AED";
const ORANGE = "#FF8800";

interface Fonts {
  mono: string;
  display: string;
}

/** next/font gives the families hashed names (e.g. __JetBrains_Mono_a1b2c3);
 * read them back from the DOM instead of guessing, then make sure the
 * weights we draw with are actually loaded before the first fillText. */
async function resolveFonts(): Promise<Fonts> {
  const read = (cls: string, fallback: string) => {
    const el = document.createElement("span");
    el.className = cls;
    el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    el.textContent = "0";
    document.body.appendChild(el);
    const computed = getComputedStyle(el).fontFamily;
    el.remove();
    return computed ? `${computed}, ${fallback}` : fallback;
  };
  const fonts: Fonts = {
    mono: read("font-mono", "ui-monospace, Menlo, monospace"),
    display: read("font-display", "system-ui, sans-serif"),
  };
  try {
    await Promise.all([
      document.fonts.load(`600 24px ${fonts.mono}`),
      document.fonts.load(`500 24px ${fonts.mono}`),
      document.fonts.load(`700 24px ${fonts.display}`),
      document.fonts.load(`500 24px ${fonts.display}`),
    ]);
  } catch {
    /* fall back to whatever is available — the card still renders */
  }
  return fonts;
}

const logoCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadLogo(url: string): Promise<HTMLImageElement | null> {
  let p = logoCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null); // no logo → card still renders
      img.src = url; // same-origin, so the canvas stays untainted for toBlob()
    });
    logoCache.set(url, p);
  }
  return p;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  // ctx.roundRect isn't in older Safari — arcTo works everywhere.
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** ctx.letterSpacing isn't universal yet, so track manually. Returns drawn width. */
function trackedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
  align: "left" | "right" = "left"
): number {
  const chars = Array.from(text);
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);
  let cx = align === "right" ? x - total : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + tracking;
  });
  ctx.textAlign = prevAlign;
  return total;
}

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  family: string,
  maxWidth: number,
  startPx: number,
  minPx: number
): number {
  let px = startPx;
  while (px > minPx) {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    px -= 2;
  }
  ctx.font = `${weight} ${px}px ${family}`;
  return px;
}

function glow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rgb: string, alpha: number) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PNL_CARD_WIDTH, PNL_CARD_HEIGHT);
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

export async function renderPnlCard(data: PnlCardData, opts: PnlCardOptions = {}): Promise<RenderedPnlCard> {
  const scale = opts.scale ?? 1.5;
  const showWallet = opts.showWallet ?? true;
  const showAmounts = opts.showAmounts ?? true;
  const W = PNL_CARD_WIDTH;
  const H = PNL_CARD_HEIGHT;

  const [fonts, logo] = await Promise.all([resolveFonts(), loadLogo(opts.logoUrl ?? "/logo.png")]);

  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available in this browser");
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";

  const win = data.roiPct >= 0;
  const hero = win ? GREEN : RED;
  const heroRgb = hexToRgb(hero);
  const symbol = sanitizeSymbol(data.symbol);
  const tier = pnlTier(data.roiPct);
  const dim = "rgba(242,244,248,0.56)";

  /* --- background ------------------------------------------------- */
  ctx.fillStyle = "#05070D";
  ctx.fillRect(0, 0, W, H);
  glow(ctx, 1020, 70, 560, hexToRgb(ORANGE), 0.2);
  glow(ctx, 90, 640, 560, hexToRgb(CYAN), 0.2);
  glow(ctx, 520, 330, 620, heroRgb, 0.11);
  glow(ctx, 640, 20, 420, hexToRgb(PURPLE), 0.2);

  // faint grid + scanlines: the cyberpunk texture, kept well under the content
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 40) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.018)";
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);

  // oversized logo as a screen-blended watermark (its black bg adds nothing)
  if (logo) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.06;
    ctx.beginPath();
    ctx.arc(930, 470, 300, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, 630, 170, 600, 600);
    ctx.restore();
  }

  /* --- glass panel ------------------------------------------------ */
  const PX = 36;
  const PY = 36;
  const PW = W - PX * 2;
  const PH = H - PY * 2;
  rr(ctx, PX, PY, PW, PH, 28);
  const glass = ctx.createLinearGradient(0, PY, 0, PY + PH);
  glass.addColorStop(0, "rgba(255,255,255,0.075)");
  glass.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = glass;
  ctx.fill();
  const edge = ctx.createLinearGradient(PX, PY, PX + PW, PY + PH);
  edge.addColorStop(0, "rgba(34,211,238,0.6)");
  edge.addColorStop(0.5, "rgba(124,58,237,0.45)");
  edge.addColorStop(1, "rgba(255,136,0,0.6)");
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // HUD corner ticks
  ctx.strokeStyle = "rgba(34,211,238,0.85)";
  ctx.lineWidth = 2;
  const tick = 22;
  const corners: [number, number, number, number][] = [
    [PX + 14, PY + 14, 1, 1],
    [PX + PW - 14, PY + 14, -1, 1],
    [PX + 14, PY + PH - 14, 1, -1],
    [PX + PW - 14, PY + PH - 14, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * tick);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * tick, cy);
    ctx.stroke();
  }

  /* --- header ----------------------------------------------------- */
  const LEFT = 78;
  const RIGHT = W - 78;
  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(LEFT + 26, 96, 26, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(logo, LEFT, 70, 52, 52);
    ctx.restore();
    ctx.strokeStyle = "rgba(34,211,238,0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(LEFT + 26, 96, 27, 0, Math.PI * 2);
    ctx.stroke();
  }
  const brandX = LEFT + (logo ? 68 : 0);
  ctx.fillStyle = "#F2F4F8";
  ctx.font = `700 22px ${fonts.display}`;
  trackedText(ctx, "JOBLESS INTEL", brandX, 92, 3.2);
  ctx.fillStyle = dim;
  ctx.font = `500 13px ${fonts.mono}`;
  trackedText(ctx, "TRADING TERMINAL", brandX, 114, 2.6);

  // status pill (right)
  const statusText = data.status === "closed" ? "REALIZED" : "UNREALIZED";
  ctx.font = `600 13px ${fonts.mono}`;
  const statusW = ctx.measureText(statusText).width + statusText.length * 2.2 + 44;
  const pillX = RIGHT - statusW;
  rr(ctx, pillX, 76, statusW, 34, 17);
  ctx.fillStyle = `rgba(${heroRgb},0.12)`;
  ctx.fill();
  ctx.strokeStyle = `rgba(${heroRgb},0.6)`;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = hero;
  ctx.beginPath();
  ctx.arc(pillX + 18, 93, 4, 0, Math.PI * 2);
  ctx.fill();
  trackedText(ctx, statusText, pillX + 32, 98, 2.2);

  const cursorRight = pillX - 12;
  if (data.onChainVerified) {
    const label = "ON-CHAIN";
    ctx.font = `600 13px ${fonts.mono}`;
    const vw = ctx.measureText(label).width + label.length * 2.2 + 46;
    const vx = cursorRight - vw;
    rr(ctx, vx, 76, vw, 34, 17);
    ctx.fillStyle = "rgba(34,211,238,0.10)";
    ctx.fill();
    ctx.strokeStyle = "rgba(34,211,238,0.55)";
    ctx.stroke();
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 2;
    ctx.beginPath(); // check mark drawn as a path — no glyph-availability risk
    ctx.moveTo(vx + 13, 93);
    ctx.lineTo(vx + 18, 98);
    ctx.lineTo(vx + 27, 88);
    ctx.stroke();
    ctx.fillStyle = CYAN;
    trackedText(ctx, label, vx + 36, 98, 2.2);
  }

  /* --- left column: symbol, badges, ROI --------------------------- */
  const COL_W = 640;
  ctx.fillStyle = "#FFFFFF";
  fitFont(ctx, `$${symbol}`, 700, fonts.display, COL_W, 68, 36);
  ctx.fillText(`$${symbol}`, LEFT, 210);

  // chips: wallet + tier
  let chipX = LEFT;
  const chipY = 232;
  const chip = (text: string, color: string, filled: boolean) => {
    ctx.font = `600 14px ${fonts.mono}`;
    const w = ctx.measureText(text).width + text.length * 1.4 + 28;
    rr(ctx, chipX, chipY, w, 32, 8);
    ctx.fillStyle = filled ? `rgba(${hexToRgb(color)},0.16)` : "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = filled ? `rgba(${hexToRgb(color)},0.65)` : "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = filled ? color : "rgba(242,244,248,0.82)";
    trackedText(ctx, text, chipX + 14, chipY + 21, 1.4);
    chipX += w + 10;
  };
  chip(tier.label, tier.color, true);
  if (showWallet && data.walletAddress) chip(shortAddr(data.walletAddress), "#FFFFFF", false);

  // ROI hero — the one loud element on the card
  const roiText = formatRoi(data.roiPct);
  ctx.fillStyle = dim;
  ctx.font = `500 15px ${fonts.mono}`;
  trackedText(ctx, "RETURN ON INVESTMENT", LEFT, 314, 3);

  ctx.save();
  const px = fitFont(ctx, roiText, 700, fonts.display, COL_W, 150, 72);
  const roiGrad = ctx.createLinearGradient(LEFT, 316, LEFT + COL_W, 470);
  roiGrad.addColorStop(0, win ? "#7CFFC4" : "#FF8FA3");
  roiGrad.addColorStop(1, hero);
  ctx.fillStyle = roiGrad;
  ctx.shadowColor = `rgba(${heroRgb},0.55)`;
  ctx.shadowBlur = 36;
  ctx.fillText(roiText, LEFT, 314 + px * 0.86);
  ctx.restore();

  const mult = formatMultiple(data.roiPct);
  if (mult && showAmounts) {
    // (with amounts hidden the right-hand card already shows the multiple)
    ctx.font = `600 22px ${fonts.mono}`;
    const mw = ctx.measureText(mult).width + 32;
    const my = 314 + px * 0.86 + 20;
    rr(ctx, LEFT, my, mw, 40, 10);
    ctx.fillStyle = `rgba(${heroRgb},0.14)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${heroRgb},0.6)`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = hero;
    ctx.fillText(mult, LEFT + 16, my + 28);
  }

  /* --- right column: stat cards ----------------------------------- */
  const CX = 752;
  const CW = RIGHT - CX;
  const statCard = (y: number, h: number) => {
    rr(ctx, CX, y, CW, h, 16);
    ctx.fillStyle = "rgba(255,255,255,0.045)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.11)";
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  const label = (text: string, x: number, y: number) => {
    ctx.fillStyle = dim;
    ctx.font = `500 13px ${fonts.mono}`;
    trackedText(ctx, text, x, y, 2.4);
  };

  // entry vs exit
  const c1y = 150;
  statCard(c1y, 150);
  const exitLabel = data.status === "closed" ? "EXIT" : "NOW";
  const priceRow = (rowY: number, name: string, value: number, color: string) => {
    label(name, CX + 24, rowY);
    ctx.fillStyle = color;
    const txt = formatPrice(value, data.priceUnit);
    fitFont(ctx, txt, 600, fonts.mono, CW - 48 - 60, 27, 15);
    ctx.textAlign = "right";
    ctx.fillText(txt, CX + CW - 24 - (data.priceUnit === "SOL" ? 44 : 0), rowY + 2);
    if (data.priceUnit === "SOL") {
      ctx.fillStyle = dim;
      ctx.font = `500 13px ${fonts.mono}`;
      ctx.fillText("SOL", CX + CW - 24, rowY + 2);
    }
    ctx.textAlign = "left";
  };
  priceRow(c1y + 50, "ENTRY", data.entryPrice, "#F2F4F8");
  ctx.strokeStyle = "rgba(255,255,255,0.09)";
  ctx.beginPath();
  ctx.moveTo(CX + 24, c1y + 75);
  ctx.lineTo(CX + CW - 24, c1y + 75);
  ctx.stroke();
  priceRow(c1y + 118, exitLabel, data.exitPrice, hero);

  // profit / multiple card
  const c2y = c1y + 150 + 16;
  statCard(c2y, 168);
  ctx.save();
  const c2grad = ctx.createLinearGradient(CX, c2y, CX + CW, c2y + 168);
  c2grad.addColorStop(0, `rgba(${heroRgb},0.13)`);
  c2grad.addColorStop(1, `rgba(${heroRgb},0.02)`);
  rr(ctx, CX, c2y, CW, 168, 16);
  ctx.fillStyle = c2grad;
  ctx.fill();
  ctx.restore();

  if (showAmounts) {
    const pnlWord = data.pnlSol >= 0 ? "PROFIT" : "LOSS";
    label(`${data.status === "closed" ? "REALIZED" : "UNREALIZED"} ${pnlWord}`, CX + 24, c2y + 42);
    const pnlText = formatSol(data.pnlSol, true);
    ctx.save();
    ctx.fillStyle = hero;
    ctx.shadowColor = `rgba(${heroRgb},0.5)`;
    ctx.shadowBlur = 22;
    fitFont(ctx, pnlText, 700, fonts.display, CW - 48 - 70, 60, 30);
    const tw = ctx.measureText(pnlText).width;
    ctx.fillText(pnlText, CX + 24, c2y + 106);
    ctx.restore();
    ctx.fillStyle = dim;
    ctx.font = `600 22px ${fonts.mono}`;
    ctx.fillText("SOL", CX + 24 + tw + 12, c2y + 106);
    if (data.costSol != null && data.costSol > 0) {
      ctx.fillStyle = dim;
      ctx.font = `500 14px ${fonts.mono}`;
      ctx.fillText(`cost basis ${formatSol(data.costSol)} SOL`, CX + 24, c2y + 142);
    }
  } else {
    label("RETURN MULTIPLE", CX + 24, c2y + 42);
    const m = formatMultiple(data.roiPct) ?? `${(1 + data.roiPct / 100).toFixed(2)}x`;
    ctx.save();
    ctx.fillStyle = hero;
    ctx.shadowColor = `rgba(${heroRgb},0.5)`;
    ctx.shadowBlur = 22;
    fitFont(ctx, m, 700, fonts.display, CW - 48, 64, 30);
    ctx.fillText(m, CX + 24, c2y + 112);
    ctx.restore();
    ctx.fillStyle = dim;
    ctx.font = `500 14px ${fonts.mono}`;
    ctx.fillText("position size hidden", CX + 24, c2y + 146);
  }

  /* --- footer ------------------------------------------------------ */
  const FY = 540;
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LEFT, FY);
  ctx.lineTo(RIGHT, FY);
  ctx.stroke();

  const refDisplay = data.referralUrl ? data.referralUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  ctx.fillStyle = "#F2F4F8";
  ctx.font = `600 17px ${fonts.display}`;
  ctx.fillText("Trade the trenches with Jobless Intel", LEFT, FY + 40);
  if (refDisplay) {
    ctx.fillStyle = CYAN;
    fitFont(ctx, refDisplay, 500, fonts.mono, 560, 16, 11);
    ctx.fillText(refDisplay, LEFT, FY + 66);
  }

  ctx.textAlign = "right";
  if (data.referralCode) {
    const code = data.referralCode.slice(0, 16).toUpperCase();
    ctx.font = `600 15px ${fonts.mono}`;
    const cw = ctx.measureText(code).width + code.length * 1.6 + 84;
    rr(ctx, RIGHT - cw, FY + 16, cw, 34, 9);
    ctx.fillStyle = "rgba(255,136,0,0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,136,0,0.6)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = dim;
    ctx.font = `500 12px ${fonts.mono}`;
    trackedText(ctx, "REF", RIGHT - cw + 14, FY + 38, 2);
    ctx.fillStyle = ORANGE;
    ctx.font = `600 15px ${fonts.mono}`;
    trackedText(ctx, code, RIGHT - cw + 54, FY + 38, 1.6);
    ctx.textAlign = "right";
  }
  if (data.txSignature) {
    ctx.fillStyle = dim;
    ctx.font = `500 13px ${fonts.mono}`;
    ctx.fillText(`tx ${shortAddr(data.txSignature, 5, 5)}`, RIGHT, FY + 68);
  } else if (data.status === "open") {
    ctx.fillStyle = dim;
    ctx.font = `500 13px ${fonts.mono}`;
    ctx.fillText("live snapshot · not yet realized", RIGHT, FY + 68);
  }
  ctx.textAlign = "left";

  /* --- export ------------------------------------------------------- */
  const encode = (type: "image/png" | "image/jpeg", quality = 0.92) =>
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode PnL card"))), type, quality)
    );
  const blob = await encode("image/png");
  return { blob, encode, objectUrl: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
}

/* ------------------------------------------------------------------ */
/* Clipboard / download / share                                        */
/* ------------------------------------------------------------------ */

export function canCopyImage(): boolean {
  return typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
}

/** Throws if the browser refuses (Firefox <127, insecure origin, no permission). */
export async function copyPnlCard(blob: Blob): Promise<void> {
  if (!canCopyImage()) throw new Error("This browser can't copy images — use Download instead.");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function downloadPnlCard(blob: Blob, symbol: string): void {
  const ext = blob.type === "image/jpeg" ? "jpg" : "png";
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jobless-pnl-${sanitizeSymbol(symbol).toLowerCase()}-${Date.now()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function buildShareText(data: PnlCardData, showAmounts = true): string {
  const sym = `$${sanitizeSymbol(data.symbol)}`;
  const roi = formatRoi(data.roiPct);
  const verb = data.status === "closed" ? "Closed" : "Holding";
  const amount = showAmounts ? ` (${formatSol(data.pnlSol, true)} SOL)` : "";
  return `${verb} ${sym} at ${roi}${amount} on Jobless Intel 🚀`;
}

export function buildXIntentUrl(text: string, url?: string): string {
  const p = new URLSearchParams({ text });
  if (url) p.set("url", url);
  return `https://twitter.com/intent/tweet?${p.toString()}`;
}

export function buildTelegramShareUrl(text: string, url?: string): string {
  // Telegram's share endpoint requires a url param; fall back to this site.
  const p = new URLSearchParams({ url: url ?? (typeof window !== "undefined" ? window.location.origin : ""), text });
  return `https://t.me/share/url?${p.toString()}`;
}

export function canNativeShareImage(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File([new Blob(["x"])], "pnl.jpg", { type: "image/jpeg" })] });
  } catch {
    return false;
  }
}

/** Mobile share sheet with the image attached — the only route that puts the
 * card itself into X / Telegram (their web intents can't attach images). */
export async function nativeSharePnlCard(blob: Blob, text: string, url?: string): Promise<void> {
  const file = new File([blob], blob.type === "image/jpeg" ? "jobless-pnl.jpg" : "jobless-pnl.png", { type: blob.type });
  await navigator.share({ files: [file], text: url ? `${text}\n${url}` : text });
}
