-- Devices created before orientation overrides were introduced do not have
-- this optional display setting yet, and no migration ever added it: the column
-- shipped in src/db/schema.ts only, so fresh databases lacked it entirely and
-- every query selecting it (including /api/v1/ink/render) failed. Idempotent so
-- upgraded and fresh databases converge.
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "orientation_override" text;
