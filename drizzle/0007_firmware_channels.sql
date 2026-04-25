-- Migration: 0007_firmware_channels
-- OTA firmware distribution with channels (stable/beta/pinned)

CREATE TABLE IF NOT EXISTS "firmware_channels" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "name" text NOT NULL UNIQUE,
  "manifest_url" text NOT NULL,
  "manifest_cache" jsonb,
  "cached_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "firmware_channel_id" uuid REFERENCES "firmware_channels"("id");
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "firmware_pin_version" text;

-- Seed default channels
INSERT INTO "firmware_channels" ("name", "manifest_url") VALUES
  ('stable', 'https://github.com/example/vellum/releases/latest/download/firmware-manifest.json'),
  ('beta', 'https://github.com/example/vellum/releases/download/beta/firmware-manifest.json')
ON CONFLICT ("name") DO NOTHING;
