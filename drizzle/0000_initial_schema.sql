-- Vellum initial schema
-- No DB enums — all types validated in application code (SSOT)

CREATE TABLE "data_providers" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "type" text NOT NULL,
  "category" text NOT NULL DEFAULT 'calendar',
  "name" text NOT NULL,
  "encrypted_credentials" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "themes" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "content_instances" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "type_slug" text NOT NULL,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "refresh_profiles" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "devices" (
  "mac" text PRIMARY KEY,
  "status" text NOT NULL DEFAULT 'pending',
  "token" text,
  "public_key" text,
  "display_caps" jsonb,
  "content_instance_id" uuid REFERENCES "content_instances"("id"),
  "theme_id" uuid REFERENCES "themes"("id"),
  "refresh_profile_id" uuid REFERENCES "refresh_profiles"("id"),
  "firmware_channel" text DEFAULT 'stable',
  "firmware_pin_version" text,
  "approved_at" timestamp,
  "last_seen" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "telemetry" (
  "id" serial PRIMARY KEY,
  "mac" text NOT NULL REFERENCES "devices"("mac"),
  "battery_voltage" real,
  "battery_level" integer,
  "wifi_rssi" integer,
  "firmware_version" text,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "reports" (
  "id" serial PRIMARY KEY,
  "mac" text NOT NULL REFERENCES "devices"("mac"),
  "issue" text,
  "timestamp" timestamp DEFAULT now() NOT NULL
);
