-- Keep read-only system visibility distinct from update authority. Existing
-- installations already have these system roles; fresh installations receive
-- the same grants from seedAccessControl after the bootstrap owner is created.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", 'system.read'
FROM "access_roles"
WHERE "id" IN ('administrator', 'auditor', 'viewer')
ON CONFLICT ("role_id", "permission") DO NOTHING;
