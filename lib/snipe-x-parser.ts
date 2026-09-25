/**
 * SnipeX Alpha Parser
 * ------------------------------------------------------------------
 * Pure text-in, structured-out extraction of Solana contract addresses
 * (and light signal around them) from live social/alpha feed text —
 * tweets, Telegram messages, Discord, whatever SnipeXFeedPanel wires up
 * as a source. No I/O here on purpose: this file has zero dependencies
 * so it's trivially unit-testable and safe to run on every incoming
 * message without touching the network.
 *
 * Base58 heuristic, not a guarantee: a Solana address is a base58-encoded
 * 32-byte public key, which is *usually* 32-44 characters, but base58
 * length isn't a fixed function of byte length (leading zero bytes encode
 * shorter), so this regex is a filter, not a proof. `looksLikeMint` below
 * does the one cheap validity check we CAN do for free (decodes to
 * exactly 32 bytes) without hitting RPC — still not proof the mint exists
 * on-chain, just that the string is shaped like a real pubkey.
 */

// Base58 alphabet excludes 0, O, I, l to avoid visual ambiguity.
const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RE = new RegExp(`\\b[${BASE58_CHARS}]{32,44}\\b`, "g");

// Common false-positive shapes worth filtering before they ever reach a
// scorecard lookup: tx signatures (base58 but ~87-88 chars, already
// excluded by length), and a short list of well-known non-mint addresses
// that show up constantly in trading chatter (SOL itself, popular program
// ids) which would otherwise get treated as "someone dropped a CA".
const KNOWN_NON_MINTS = new Set<string>([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022 program
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111", // System program
]);

export interface ParsedAlphaMention {
  mint: string;
  /** Where in the source text this was found — lets the UI highlight it. */
  index: number;
  /** Cheap on-string validity check passed (see module doc). Doesn't hit the network. */
  plausible: boolean;
  /** Nearby words that commonly signal conviction or a warning, lowercased. */
  contextTags: string[];
}

const BULLISH_WORDS = ["moon", "gem", "send", "ape", "early", "100x", "lfg", "bullish", "based"];
const CAUTION_WORDS = ["rug", "scam", "honeypot", "caution", "careful", "sus", "avoid"];

/** Base58 decode without pulling in bs58 as a dependency — this file has
 * none on purpose. Returns byte length only; callers don't need the bytes. */
function base58DecodedByteLength(s: string): number | null {
  let num = 0n;
  const base = 58n;
  for (const ch of s) {
    const digit = BASE58_CHARS.indexOf(ch);
    if (digit === -1) return null;
    num = num * base + BigInt(digit);
  }
  let byteLen = 0;
  let n = num;
  while (n > 0n) {
    n >>= 8n;
    byteLen++;
  }
  // Each leading base58 '1' encodes one leading zero byte.
  let leadingOnes = 0;
  for (const ch of s) {
    if (ch === "1") leadingOnes++;
    else break;
  }
  return byteLen + leadingOnes;
}

/** A Solana public key is always exactly 32 bytes. */
export function looksLikeMint(candidate: string): boolean {
  if (KNOWN_NON_MINTS.has(candidate)) return false;
  return base58DecodedByteLength(candidate) === 32;
}

function extractContextTags(text: string, index: number, match: string): string[] {
  const windowStart = Math.max(0, index - 60);
  const windowEnd = Math.min(text.length, index + match.length + 60);
  const window = text.slice(windowStart, windowEnd).toLowerCase();
  const tags = new Set<string>();
  for (const w of BULLISH_WORDS) if (window.includes(w)) tags.add(w);
  for (const w of CAUTION_WORDS) if (window.includes(w)) tags.add(w);
  return Array.from(tags);
}

/** Extracts every candidate mint address from a chunk of feed text, with
 * light surrounding context. Dedupes by mint, keeping the first occurrence. */
export function parseAlphaMentions(text: string): ParsedAlphaMention[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: ParsedAlphaMention[] = [];

  for (const match of text.matchAll(BASE58_RE)) {
    const mint = match[0];
    const index = match.index ?? 0;
    if (seen.has(mint)) continue;
    seen.add(mint);
    out.push({
      mint,
      index,
      plausible: looksLikeMint(mint),
      contextTags: extractContextTags(text, index, mint),
    });
  }
  return out;
}

/** Convenience for a feed that only cares about plausible mints, e.g. to
 * decide whether a message is even worth a creator-audit lookup. */
export function extractPlausibleMints(text: string): string[] {
  return parseAlphaMentions(text)
    .filter((m) => m.plausible)
    .map((m) => m.mint);
}
