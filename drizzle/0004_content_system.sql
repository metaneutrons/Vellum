-- Migration: 0004_content_system
-- Adds calendar providers, themes, content types/instances, and device FKs.

-- Calendar provider type enum
DO $$ BEGIN
  CREATE TYPE "calendar_provider_type" AS ENUM ('microsoft365', 'google', 'ical');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Calendar providers
CREATE TABLE IF NOT EXISTS "calendar_providers" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "type" "calendar_provider_type" NOT NULL,
  "name" text NOT NULL,
  "encrypted_credentials" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Themes
CREATE TABLE IF NOT EXISTS "themes" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Content types (renderer registry)
CREATE TABLE IF NOT EXISTS "content_types" (
  "slug" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text
);

-- Seed the room-booking content type
INSERT INTO "content_types" ("slug", "name", "description")
VALUES ('room-booking', 'Raumbelegung', 'Outlook-style calendar day view for meeting rooms')
ON CONFLICT ("slug") DO NOTHING;

-- Content instances
CREATE TABLE IF NOT EXISTS "content_instances" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "type_slug" text NOT NULL REFERENCES "content_types"("slug"),
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Add FKs to devices (nullable — device may not have content/theme yet)
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "content_instance_id" uuid REFERENCES "content_instances"("id");
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "theme_id" uuid REFERENCES "themes"("id");

-- Remove old room columns from devices (moved to content_instances.config)
ALTER TABLE "devices" DROP COLUMN IF EXISTS "room_email";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "room_name";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "room_timezone";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "room_policy";

-- Indexes
CREATE INDEX IF NOT EXISTS "idx_content_instances_type" ON "content_instances" ("type_slug");
CREATE INDEX IF NOT EXISTS "idx_devices_content" ON "devices" ("content_instance_id");
CREATE INDEX IF NOT EXISTS "idx_devices_theme" ON "devices" ("theme_id");
