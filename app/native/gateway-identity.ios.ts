declare const FaceclawGatewayIdentity: any;

export type GatewayChallengeSignature = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export function signGatewayChallenge(
  origin: string,
  token: string,
  scopes: string[],
  nonce: string,
  signedAtMs: number,
): GatewayChallengeSignature {
  const result = JSON.parse(String(
    FaceclawGatewayIdentity.signGatewayChallengeTokenScopesNonceSignedAtMs(origin, token, scopes, nonce, signedAtMs),
  )) as Partial<GatewayChallengeSignature> & { error?: string };
  if (result.error) throw new Error(result.error);
  if (typeof result.id !== "string" || typeof result.publicKey !== "string" ||
      typeof result.signature !== "string" || typeof result.signedAt !== "number" ||
      result.nonce !== nonce) {
    throw new Error("Invalid gateway identity response");
  }
  return result as GatewayChallengeSignature;
}
