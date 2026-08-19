-- Per-display backlight override, 0-100, null for "follow the profile".
--
-- Null rather than a sentinel because 0 is a legitimate value: it turns the
-- backlight off, and a magic number would make that indistinguishable from unset.
--
-- Unmodified drizzle-kit output.
ALTER TABLE "devices" ADD COLUMN "backlight_percent" integer;