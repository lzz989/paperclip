# VibeLife OIDC candidate

This is a candidate for Paperclip commit `1b4c803` and Better Auth `1.7.2`.
It does not provision an Owner or issue a handoff ticket. Enable it only in
authenticated mode with the explicit auth base URL `https://dashboard.majiu.xyz`.
The provider callback is `https://dashboard.majiu.xyz/api/auth/callback/vibelife`;
the OIDC client ID is `paperclip`. `VIBELIFE_PAPERCLIP_OIDC=enabled` requires
`VIBELIFE_PAPERCLIP_OIDC_CLIENT_SECRET` to be supplied by the operator through
the existing secret mechanism. Never put it in this repository or a command line.
The P2 record identifies `https://dashboard.majiu.xyz` as the existing
Paperclip origin. Its SSO 1.0.3 record registers Homarr, FreshRSS and an Outline
candidate, not Paperclip. Its source permits only those client IDs; a separately
reviewed SSO extension registering Paperclip and this exact callback is required.
This candidate requests `openid profile` and `client_secret_basic`, consistent
with the existing non-Outline client policy, but no Paperclip policy exists yet.

Better Auth verifies the ID-token signature, issuer, audience and expiry; its
authorization-code callback also binds the nonce. Direct ID-token sign-in uses
Better Auth's native verification rather than a custom nonce gate. Both require
a present ID token, matching ID-token and profile subjects, the
fixed issuer and subject, and an existing `(issuer, account_id, provider_id)`
binding to a current `instance_admin`. A technical `identity.invalid` email is
mapped with `emailVerified: false`; it is not an identity proof or a real email.
OIDC registration, implicit email linking and interactive account linking are
disabled when this integration is enabled. Existing local email login remains
subject to the instance's own configuration.

## Pre-binding review

`vibelife-oidc-prebind.sql` is a transaction template, not an applied migration.
Independently identify the intended existing Owner's exact `user.id` and confirm
its `instance_admin` role; do not pick an account by email or create a user. The
template locks the relevant tables, refuses a missing role or conflicting
issuer/subject binding, and otherwise inserts only the account binding. It is
idempotent for the exact same binding and ends in `ROLLBACK`. Review its result
on isolated synthetic data first. Any later production execution requires its
own authorization and an independently reviewed change to commit; a dry run
alone does not create a binding. Remove a binding for rollback only after
reviewing the exact row and the effect on access; do not delete the Owner.

Before any rollout, verify with the existing SSO owner that discovery publishes
the exact issuer, supported signing algorithms, JWKS, authorization/token and
userinfo endpoints, and that the code flow supports PKCE and echoes Better
Auth's nonce in the ID token. Confirm the registered client and callback and
perform a full isolated integration test, including failed/missing ID token,
wrong issuer/subject, unbound account, non-admin, email collision, existing
Owner, and callback state/nonce cases. This candidate has not established that
the existing SSO meets those requirements. The binding/role check and Better
Auth's subsequent session creation are separate database operations; role or
binding changes racing an in-flight callback require operational coordination.
