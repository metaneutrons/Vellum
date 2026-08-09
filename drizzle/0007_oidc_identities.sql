-- OIDC identities are bound to the signed issuer + immutable subject, not to an
-- email address. This prevents account takeover through a recycled/renamed UPN.
CREATE TABLE IF NOT EXISTS "oidc_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "issuer" text NOT NULL,
  "subject" text NOT NULL,
  "tenant_id" text NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_login_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oidc_identities_issuer_subject_idx" ON "oidc_identities" ("issuer", "subject");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oidc_identities_user_idx" ON "oidc_identities" ("user_id");
