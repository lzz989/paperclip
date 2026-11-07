-- Review-only template. Replace the placeholder with the independently identified
-- existing Owner user.id. Default ROLLBACK is intentional; see the companion note.
BEGIN;
LOCK TABLE "user", instance_user_roles, account IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE vibelife_bind_input (owner_id text NOT NULL) ON COMMIT DROP;
INSERT INTO vibelife_bind_input VALUES ('<EXPLICIT_EXISTING_OWNER_USER_ID>');

DO $$
DECLARE
  owner_id text := (SELECT i.owner_id FROM vibelife_bind_input i);
  existing account%ROWTYPE;
BEGIN
  IF owner_id = '<EXPLICIT_EXISTING_OWNER_USER_ID>' OR btrim(owner_id) = '' THEN
    RAISE EXCEPTION 'explicit Owner ID required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "user" u JOIN instance_user_roles r ON r.user_id = u.id
    WHERE u.id = owner_id AND r.role = 'instance_admin'
  ) THEN
    RAISE EXCEPTION 'Owner must be an existing instance_admin';
  END IF;
  SELECT * INTO existing FROM account a
    WHERE a.issuer = 'https://vibelife.majiu.xyz/sso' AND a.account_id = 'vibelife-owner-1';
  IF FOUND THEN
    IF existing.user_id <> owner_id OR existing.provider_id <> 'vibelife' THEN
      RAISE EXCEPTION 'conflicting issuer/subject binding; manual review required';
    END IF;
  ELSE
    INSERT INTO account (id, issuer, account_id, provider_id, user_id, created_at, updated_at)
    VALUES (gen_random_uuid()::text, 'https://vibelife.majiu.xyz/sso', 'vibelife-owner-1', 'vibelife', owner_id, now(), now());
  END IF;
END $$;

SELECT a.issuer, a.account_id, a.provider_id, a.user_id, r.role
FROM account a JOIN instance_user_roles r ON r.user_id = a.user_id AND r.role = 'instance_admin'
WHERE a.issuer = 'https://vibelife.majiu.xyz/sso' AND a.account_id = 'vibelife-owner-1';
ROLLBACK;
