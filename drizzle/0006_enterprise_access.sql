-- Enterprise identity, authorization, sessions, invitations, service accounts,
-- and append-only audit records. All identity data is kept separate from device
-- credentials so revoking an operator can never affect a deployed display.

CREATE TABLE IF NOT EXISTS "admin_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "password_hash" text,
  "status" text NOT NULL DEFAULT 'active',
  "mfa_required" boolean NOT NULL DEFAULT false,
  "mfa_enrolled_at" timestamp,
  "last_login_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "admin_users_status_check" CHECK ("status" IN ('active', 'invited', 'suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_email_ci_idx" ON "admin_users" (lower("email"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "access_roles" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "is_system" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id" serial PRIMARY KEY,
  "role_id" text NOT NULL REFERENCES "access_roles"("id") ON DELETE CASCADE,
  "permission" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_permission_idx" ON "role_permissions" ("role_id", "permission");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_role_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "role_id" text NOT NULL REFERENCES "access_roles"("id") ON DELETE RESTRICT,
  "scope_type" text NOT NULL DEFAULT 'workspace',
  "scope_id" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "user_role_assignments_scope_check" CHECK (("scope_type" = 'workspace' AND "scope_id" IS NULL) OR ("scope_type" <> 'workspace' AND "scope_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_role_assignments_user_idx" ON "user_role_assignments" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "admin_users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_seen_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_sessions_token_hash_idx" ON "admin_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_user_idx" ON "admin_sessions" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "token_hash" text NOT NULL,
  "role_id" text NOT NULL REFERENCES "access_roles"("id") ON DELETE RESTRICT,
  "scope_type" text NOT NULL DEFAULT 'workspace',
  "scope_id" text,
  "expires_at" timestamp NOT NULL,
  "accepted_at" timestamp,
  "created_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_invitations_token_hash_idx" ON "admin_invitations" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_invitations_email_idx" ON "admin_invitations" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "token_prefix" text NOT NULL,
  "token_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "expires_at" timestamp,
  "last_used_at" timestamp,
  "created_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "service_accounts_status_check" CHECK ("status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_accounts_token_hash_idx" ON "service_accounts" ("token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_account_permissions" (
  "id" serial PRIMARY KEY,
  "service_account_id" uuid NOT NULL REFERENCES "service_accounts"("id") ON DELETE CASCADE,
  "permission" text NOT NULL,
  "scope_type" text NOT NULL DEFAULT 'workspace',
  "scope_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_account_permissions_account_idx" ON "service_account_permissions" ("service_account_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" serial PRIMARY KEY,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "scope_type" text NOT NULL DEFAULT 'workspace',
  "scope_id" text,
  "outcome" text NOT NULL DEFAULT 'success',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_actor_idx" ON "audit_logs" ("actor_id");
