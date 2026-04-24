-- Migration: 0000_initial_schema
-- Generated from src/db/schema.ts

DO $$ BEGIN
  CREATE TYPE "device_status" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "room_policy" AS ENUM ('Show All', 'Hide Subject', 'Hide All');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "devices" (
  "mac" text PRIMARY KEY NOT NULL,
  "status" "device_status" DEFAULT 'pending' NOT NULL,
  "token" text,
  "room_email" text,
  "room_name" text,
  "room_timezone" text DEFAULT 'UTC',
  "room_policy" "room_policy" DEFAULT 'Show All',
  "approved_at" timestamp,
  "last_seen" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "telemetry" (
  "id" serial PRIMARY KEY NOT NULL,
  "mac" text NOT NULL REFERENCES "devices"("mac"),
  "battery_voltage" real,
  "battery_level" integer,
  "wifi_rssi" integer,
  "firmware_version" text,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "reports" (
  "id" serial PRIMARY KEY NOT NULL,
  "mac" text NOT NULL REFERENCES "devices"("mac"),
  "issue" text,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS "idx_telemetry_mac" ON "telemetry" ("mac");
CREATE INDEX IF NOT EXISTS "idx_telemetry_timestamp" ON "telemetry" ("timestamp");
CREATE INDEX IF NOT EXISTS "idx_reports_mac" ON "reports" ("mac");
CREATE INDEX IF NOT EXISTS "idx_devices_status" ON "devices" ("status");
