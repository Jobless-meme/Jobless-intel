import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { PublicKey } from "@solana/web3.js";
import { buildSignInMessage } from "@/lib/auth/sign-in-message";

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const walletAddress = body?.publicKey;
  if (!walletAddress || typeof walletAddress !== "string") {
    return NextResponse.json({ error: "publicKey is required" }, { status: 400 });
  }
  try {
    new PublicKey(walletAddress); // throws on invalid base58 pubkey
  } catch {
    return NextResponse.json({ error: "Invalid Solana public key" }, { status: 400 });
  }

  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();

  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("auth_nonces")
    .upsert({ wallet_address: walletAddress, nonce, expires_at: expiresAt });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    nonce,
    message: buildSignInMessage(walletAddress, nonce),
    expiresAt,
  });
}
