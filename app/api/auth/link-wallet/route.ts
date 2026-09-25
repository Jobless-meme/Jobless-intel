import { NextRequest, NextResponse } from "next/server";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { buildSignInMessage } from "@/lib/auth/sign-in-message";

/**
 * Proves wallet ownership (nonce + signature, verified here, server-side)
 * before persisting the wallet <-> Supabase-identity link. Deliberately
 * does NOT use the service-role key to write to public.users — it builds
 * a client scoped to the caller's own access token and calls the
 * link_solana_wallet RPC as them, so normal RLS/SECURITY DEFINER rules
 * apply. The service-role key here touches only auth_nonces, to read and
 * then delete the single-use challenge.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const { publicKey, signature, accessToken } = body ?? {};
  if (!publicKey || !signature || !accessToken) {
    return NextResponse.json({ error: "publicKey, signature, and accessToken are required" }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();

  const { data: nonceRow, error: nonceErr } = await admin
    .from("auth_nonces")
    .select("nonce, expires_at")
    .eq("wallet_address", publicKey)
    .maybeSingle();

  if (nonceErr || !nonceRow) {
    return NextResponse.json({ error: "No pending sign-in challenge for this wallet — request a nonce first" }, { status: 400 });
  }
  if (new Date(nonceRow.expires_at).getTime() < Date.now()) {
    await admin.from("auth_nonces").delete().eq("wallet_address", publicKey);
    return NextResponse.json({ error: "Nonce expired — request a new one" }, { status: 400 });
  }

  const message = buildSignInMessage(publicKey, nonceRow.nonce);
  const messageBytes = new TextEncoder().encode(message);

  let signatureBytes: Uint8Array;
  let pubkeyBytes: Uint8Array;
  try {
    signatureBytes = Uint8Array.from(Buffer.from(signature, "base64"));
    pubkeyBytes = new PublicKey(publicKey).toBytes();
  } catch {
    return NextResponse.json({ error: "Malformed publicKey or signature" }, { status: 400 });
  }

  const validSig = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
  if (!validSig) {
    return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
  }

  // Nonce is single-use — consume it immediately so a captured request
  // can't be replayed.
  await admin.from("auth_nonces").delete().eq("wallet_address", publicKey);

  // Now act AS the caller's own session (not as admin) so RLS + the
  // SECURITY DEFINER function apply exactly as they would for any other
  // authenticated request.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const userScopedClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await userScopedClient.auth.getUser();
  if (userErr || !userData?.user) {
    return NextResponse.json({ error: "Invalid or expired session — sign in anonymously again" }, { status: 401 });
  }

  const { error: rpcErr } = await userScopedClient.rpc("link_solana_wallet", { wallet_addr: publicKey });
  if (rpcErr) {
    // Most likely cause: this wallet is already linked to a different
    // browser/session (sol_wallet_address is UNIQUE) — see the note in
    // supabase/schema.sql. No cross-device merge flow exists yet.
    return NextResponse.json({ error: rpcErr.message }, { status: 409 });
  }

  return NextResponse.json({ ok: true, userId: userData.user.id });
}
