/**
 * Canonical message signed by a Solana wallet during wallet authentication.
 * Keep this in a shared module so API routes never import another route file.
 */
export function buildSignInMessage(walletAddress: string, nonce: string) {
  return `Jobless Intel Terminal wants you to sign in with your Solana wallet.\n\nWallet: ${walletAddress}\nNonce: ${nonce}\n\nThis request will not trigger a blockchain transaction or cost any gas.`;
}
