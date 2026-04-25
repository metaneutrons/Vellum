-- Migration: 0006_refresh_profiles
-- Configurable refresh profiles assignable to devices.

CREATE TABLE IF NOT EXISTS "refresh_profiles" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "refresh_profile_id" uuid REFERENCES "refresh_profiles"("id");

-- Seed default profiles
INSERT INTO "refresh_profiles" ("name", "config") VALUES
  ('Standard', '{"usbIntervalS":60,"batteryIntervalS":900,"lowBatteryIntervalS":3600,"lowBatteryThresholdPct":20,"imminentEventWindowS":1200,"wakeBeforeEventS":300,"nightModeEnabled":false,"nightStartHour":22,"nightEndHour":6,"nightIntervalS":7200}'),
  ('Frequent', '{"usbIntervalS":30,"batteryIntervalS":300,"lowBatteryIntervalS":1800,"lowBatteryThresholdPct":15,"imminentEventWindowS":1200,"wakeBeforeEventS":300,"nightModeEnabled":true,"nightStartHour":22,"nightEndHour":6,"nightIntervalS":3600}'),
  ('Power Saver', '{"usbIntervalS":120,"batteryIntervalS":1800,"lowBatteryIntervalS":7200,"lowBatteryThresholdPct":25,"imminentEventWindowS":1200,"wakeBeforeEventS":300,"nightModeEnabled":true,"nightStartHour":20,"nightEndHour":7,"nightIntervalS":7200}')
ON CONFLICT DO NOTHING;
