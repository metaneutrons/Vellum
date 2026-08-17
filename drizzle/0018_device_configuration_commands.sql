-- Durable desired-state commands for authenticated device configuration.
-- Keeping terminal rows gives operators and auditors a complete outcome
-- history while the partial unique index makes concurrent active commands
-- impossible at the database boundary.
CREATE TABLE IF NOT EXISTS "device_configuration_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mac" text NOT NULL REFERENCES "devices"("mac") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('server_url')),
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'delivered', 'applying', 'applied', 'failed', 'superseded', 'cancelled')),
  "error_code" text,
  "created_by" uuid REFERENCES "admin_users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "delivered_at" timestamp,
  "completed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "device_configuration_commands_mac_created_idx"
  ON "device_configuration_commands" ("mac", "created_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "device_configuration_commands_one_active_idx"
  ON "device_configuration_commands" ("mac")
  WHERE "status" IN ('pending', 'delivered', 'applying');
