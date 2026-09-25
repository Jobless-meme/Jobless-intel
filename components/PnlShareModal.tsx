"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@solana/wallet-adapter-react";
import { useReferralLink } from "@/hooks/useReferralLink";
import {
  buildShareText,
  buildTelegramShareUrl,
  buildXIntentUrl,
  canCopyImage,
  canNativeShareImage,
  copyPnlCard,
  downloadPnlCard,
  nativeSharePnlCard,
  renderPnlCard,
  type PnlCardData,
  type RenderedPnlCard,
} from "@/lib/pnl-card-renderer";

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`min-h-[36px] rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors ${
        on
          ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-bright)]"
          : "border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--bg-elevated)]"
      }`}
    >
      {label}: {on ? "shown" : "hidden"}
    </button>
  );
}

/**
 * Bottom-sheet PnL card. Renders the card to a canvas (lib/pnl-card-renderer)
 * and shows exactly that image, so preview === what you copy/download/share.
 * Nothing about the trade leaves the browser except what the user posts.
 */
export default function PnlShareModal({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: PnlCardData | null;
}) {
  const { publicKey } = useWallet();
  const referral = useReferralLink(publicKey?.toBase58() ?? null);

  const [showWallet, setShowWallet] = useState(true);
  const [showAmounts, setShowAmounts] = useState(true);
  const [card, setCard] = useState<RenderedPnlCard | null>(null);
  const [rendering, setRendering] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Open positions priced without a SOL quote have no SOL PnL — hide amounts rather than print "—".
  const amountsAvailable = data ? Number.isFinite(data.pnlSol) : true;
  const effectiveAmounts = amountsAvailable && showAmounts;

  const cardData = useMemo<PnlCardData | null>(
    () => (data ? { ...data, referralCode: referral.code ?? undefined, referralUrl: referral.url ?? undefined } : null),
    [data, referral.code, referral.url]
  );

  const lastUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !cardData) return;
    let cancelled = false;
    setRendering(true);
    setMessage(null);
    renderPnlCard(cardData, { showWallet, showAmounts: effectiveAmounts })
      .then((r) => {
        if (cancelled) {
          URL.revokeObjectURL(r.objectUrl);
          return;
        }
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = r.objectUrl;
        setCard(r);
      })
      .catch((err: any) => !cancelled && setMessage({ text: err?.message ?? "Couldn't render the card", tone: "warn" }))
      .finally(() => !cancelled && setRendering(false));
    return () => {
      cancelled = true;
    };
  }, [open, cardData, showWallet, effectiveAmounts]);

  useEffect(() => {
    if (open) return;
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    lastUrl.current = null;
    setCard(null);
    setMessage(null);
  }, [open]);

  const shareText = cardData ? buildShareText(cardData, effectiveAmounts) : "";

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    try {
      await fn();
    } catch (err: any) {
      if (err?.name !== "AbortError") setMessage({ text: err?.message ?? "That didn't work", tone: "warn" });
    } finally {
      setBusy(null);
    }
  }

  const copy = () =>
    run("copy", async () => {
      if (!card) return;
      await copyPnlCard(card.blob);
      setMessage({ text: "Image copied — paste it into your post.", tone: "ok" });
    });

  const download = () =>
    run("download", async () => {
      if (!card || !cardData) return;
      downloadPnlCard(card.blob, cardData.symbol);
      setMessage({ text: "Saved to your downloads.", tone: "ok" });
    });

  // X and Telegram web intents can't attach an image, so put it on the
  // clipboard in the same gesture and tell the user to paste it.
  const shareVia = (name: "x" | "telegram") =>
    run(name, async () => {
      if (!card) return;
      const link = referral.url ?? undefined;
      const target = name === "x" ? buildXIntentUrl(shareText, link) : buildTelegramShareUrl(shareText, link);
      const copied = canCopyImage() ? copyPnlCard(card.blob).then(() => true, () => false) : Promise.resolve(false);
      window.open(target, "_blank", "noopener,noreferrer");
      setMessage(
        (await copied)
          ? { text: "Image copied — paste it into the post that just opened.", tone: "ok" }
          : { text: "Post opened — use Download to attach the image.", tone: "warn" }
      );
    });

  const nativeShare = () =>
    run("native", async () => {
      if (!card) return;
      const jpeg = await card.encode("image/jpeg", 0.92); // ~10x smaller than the PNG for mobile uploads
      await nativeSharePnlCard(jpeg, shareText, referral.url ?? undefined);
    });

  const canNative = mounted && canNativeShareImage();
  const disabled = !card || rendering;

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && cardData && (
        <motion.div
          className="fixed inset-0 z-[95] flex items-end justify-center bg-black/65 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Share PnL card"
            className="relative flex max-h-[94dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-3xl border border-[var(--border)]"
            style={{ background: "var(--bg)" }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-[var(--border)] px-4 pb-3 pt-4">
              <div>
                <div className="font-display text-sm font-semibold">Share PnL</div>
                <div className="font-mono text-[10px] text-[var(--text-dim)]">
                  Rendered on this device · nothing is uploaded
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="lx-btn !px-3 !py-1.5"
              >
                ✕
              </button>
            </div>

            <div className="thin-scroll flex-1 overflow-y-auto px-4 pb-5 pt-3">
              <div
                className="relative w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]"
                style={{ aspectRatio: "16 / 9" }}
              >
                {card && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={card.objectUrl}
                    alt={`${cardData.symbol} PnL card`}
                    className={`h-full w-full object-cover transition-opacity ${rendering ? "opacity-40" : "opacity-100"}`}
                    draggable={false}
                  />
                )}
                {(rendering || !card) && (
                  <div className="absolute inset-0 flex items-center justify-center font-mono text-[11px] text-[var(--text-dim)]">
                    rendering card…
                  </div>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Toggle label="Wallet" on={showWallet} onClick={() => setShowWallet((v) => !v)} />
                {amountsAvailable && <Toggle label="SOL amounts" on={showAmounts} onClick={() => setShowAmounts((v) => !v)} />}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" className="lx-btn" disabled={disabled || busy === "copy"} onClick={copy}>
                  Copy Image
                </button>
                <button type="button" className="lx-btn" disabled={disabled || busy === "download"} onClick={download}>
                  Download Card
                </button>
                <button type="button" className="lx-btn" disabled={disabled || busy === "x"} onClick={() => shareVia("x")}>
                  Share to X
                </button>
                <button
                  type="button"
                  className="lx-btn"
                  disabled={disabled || busy === "telegram"}
                  onClick={() => shareVia("telegram")}
                >
                  Share to Telegram
                </button>
                {canNative && (
                  <button
                    type="button"
                    className="lx-btn col-span-2 !border-[var(--accent)] !text-[var(--accent-bright)]"
                    disabled={disabled || busy === "native"}
                    onClick={nativeShare}
                  >
                    Share with image…
                  </button>
                )}
              </div>

              {message && (
                <p
                  className="mt-3 font-mono text-[11px]"
                  style={{ color: message.tone === "ok" ? "var(--success)" : "var(--danger)" }}
                >
                  {message.text}
                </p>
              )}

              <p className="mt-3 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
                {referral.url ? (
                  <>
                    Your referral link is on the card and attached to the post: <span className="text-[var(--text)]">{referral.url}</span>.{" "}
                  </>
                ) : (
                  <>Connect a wallet to put your referral link on the card. </>
                )}
                {cardData.onChainVerified
                  ? "Figures come from your wallet's on-chain history — the sell transaction is printed on the card so anyone can check it. "
                  : "This is a live snapshot from current price, not a realized result. "}
                X and Telegram links can't attach images — the card is copied to your clipboard for pasting.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
