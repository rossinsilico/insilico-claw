export type GatewayChallengeSignature = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export function signGatewayChallenge(
  _origin: string,
  _token: string,
  _scopes: string[],
  _nonce: string,
  _signedAtMs: number,
): GatewayChallengeSignature {
  throw new Error("OpenClaw Gateway device identity is only available on iOS");
}
