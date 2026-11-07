export const VIBELIFE_ISSUER = "https://vibelife.majiu.xyz/sso";
export const VIBELIFE_SUBJECT = "vibelife-owner-1";
export const VIBELIFE_CALLBACK = "https://dashboard.majiu.xyz/api/auth/callback/vibelife";

/** Called after Better Auth verifies the ID token; code callbacks also bind its nonce. */
export function vibelifeSubject(tokens: { idToken?: string }, profile: { sub?: unknown }): string {
  let claims: { iss?: unknown; sub?: unknown };
  try {
    if (!tokens.idToken) throw new Error();
    const parts = tokens.idToken.split(".");
    if (parts.length !== 3) throw new Error();
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("VibeLife ID token required");
  }
  if (claims?.iss !== VIBELIFE_ISSUER || claims.sub !== VIBELIFE_SUBJECT || profile.sub !== claims.sub) {
    throw new Error("Unexpected VibeLife identity");
  }
  return VIBELIFE_SUBJECT;
}

/** The injected lookup must require the exact binding and a current instance_admin. */
export function vibelifeOidcConfig(isBoundOwner: () => Promise<boolean>, env: NodeJS.ProcessEnv = process.env) {
  if (env.VIBELIFE_PAPERCLIP_OIDC !== "enabled") return null;
  const clientSecret = env.VIBELIFE_PAPERCLIP_OIDC_CLIENT_SECRET;
  if (!clientSecret || clientSecret.length < 32) throw new Error("VibeLife OIDC client secret is required");
  return {
    providerId: "vibelife",
    discoveryUrl: `${VIBELIFE_ISSUER}/.well-known/openid-configuration`,
    accountIssuer: VIBELIFE_ISSUER,
    redirectURI: VIBELIFE_CALLBACK,
    clientId: "paperclip",
    clientSecret,
    scopes: ["openid", "profile"],
    tokenEndpointAuth: { method: "client_secret_basic" as const },
    pkce: true,
    requireIdTokenVerification: true,
    disableProviderLogout: true,
    disableImplicitSignUp: true,
    disableSignUp: true,
    overrideUserInfo: false,
    mapProfileToUser: () => ({ email: "vibelife-owner-1@identity.invalid", emailVerified: false }),
    accountSubject: async ({ tokens, profile }: { tokens: { idToken?: string }; profile: { sub?: unknown } }) => {
      const subject = vibelifeSubject(tokens, profile);
      if (!await isBoundOwner()) throw new Error("VibeLife owner binding required");
      return subject;
    },
  };
}
