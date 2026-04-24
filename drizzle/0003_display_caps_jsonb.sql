-- Migration: 0003_display_caps_jsonb
-- Replace individual display columns with a single JSONB capabilities blob.
-- The device sends its full capabilities; the server stores and uses them as-is.

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "display_caps" jsonb;

-- Migrate existing data
UPDATE "devices" SET display_caps = jsonb_build_object(
  'model', display_model,
  'width', display_width,
  'height', display_height
) WHERE display_model IS NOT NULL;

-- Drop old columns
ALTER TABLE "devices" DROP COLUMN IF EXISTS "display_model";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "display_width";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "display_height";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "display_colors";
