-- Migration: 0001_display_capabilities
-- Adds display capability fields reported by firmware

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_model" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_width" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_height" integer;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_colors" text;
