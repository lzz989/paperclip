import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VIBELIFE_CALLBACK, VIBELIFE_ISSUER, VIBELIFE_SUBJECT, vibelifeOidcConfig } from "../server/src/auth/vibelife-oidc.ts";
import { tenantSignInReturnPath } from "../ui/src/lib/cloudLinks.ts";

// These strings exercise claim handling only. They are not signed tokens or tickets.
const claims = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const env = { VIBELIFE_PAPERCLIP_OIDC: "enabled", VIBELIFE_PAPERCLIP_OIDC_CLIENT_SECRET: "synthetic-secret-for-this-test-only" };

test("return paths stay local after normalization and preserve safe query and fragment", () => {
  const safe = "/CON/issues/CON-1?tab=activity#comment";
  assert.equal(tenantSignInReturnPath(safe), safe);
  for (const path of ["https://evil.test", "//evil.test", "/\\evil.test", "/a/..//evil.test", "/%2e%2e//evil.test", "/%2f%2fevil.test", "/%255c%255cevil.test", "/%61uth", "/AUTH", "/%zz"]) {
    assert.equal(tenantSignInReturnPath(path), "/", path);
  }
});

test("OIDC requires the exact verified identity and a pre-bound administrator", async () => {
  assert.equal(vibelifeOidcConfig(async () => true, {}), null);
  assert.throws(() => vibelifeOidcConfig(async () => true, { VIBELIFE_PAPERCLIP_OIDC: "enabled" }));
  let bound = true;
  const config = vibelifeOidcConfig(async () => bound, env);
  assert.equal(config.redirectURI, VIBELIFE_CALLBACK);
  assert.equal(config.accountIssuer, VIBELIFE_ISSUER);
  assert.equal(config.requireIdTokenVerification, true);
  assert.equal(config.disableProviderLogout, true);
  assert.equal(config.pkce, true);
  assert.deepEqual(config.scopes, ["openid", "profile"]);
  assert.equal(config.tokenEndpointAuth.method, "client_secret_basic");
  assert.equal(config.disableImplicitSignUp, true);
  assert.equal(config.disableSignUp, true);
  assert.equal(config.overrideUserInfo, false);
  assert.deepEqual(config.mapProfileToUser(), { email: "vibelife-owner-1@identity.invalid", emailVerified: false });
  const valid = claims({ iss: VIBELIFE_ISSUER, sub: VIBELIFE_SUBJECT });
  const lookup = (idToken, sub) => config.accountSubject({ tokens: { idToken }, profile: { sub } });
  assert.equal(await lookup(valid, VIBELIFE_SUBJECT), VIBELIFE_SUBJECT);
  await assert.rejects(lookup(undefined, VIBELIFE_SUBJECT));
  await assert.rejects(lookup("bad", VIBELIFE_SUBJECT));
  await assert.rejects(lookup(claims({ iss: "https://other.invalid", sub: VIBELIFE_SUBJECT }), VIBELIFE_SUBJECT));
  await assert.rejects(lookup(claims({ iss: VIBELIFE_ISSUER, sub: "other" }), "other"));
  await assert.rejects(lookup(valid, "other"));
  bound = false;
  await assert.rejects(lookup(valid, VIBELIFE_SUBJECT));
  const unavailable = vibelifeOidcConfig(async () => { throw new Error("database unavailable"); }, env);
  await assert.rejects(unavailable.accountSubject({ tokens: { idToken: valid }, profile: { sub: VIBELIFE_SUBJECT } }));
});
