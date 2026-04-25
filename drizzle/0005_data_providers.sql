-- Migration: 0005_data_providers
-- Generalize calendar_providers to data_providers with a category column.

ALTER TABLE "calendar_providers" RENAME TO "data_providers";
ALTER TABLE "data_providers" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'calendar' NOT NULL;

-- Rename the type enum to be more general
ALTER TYPE "calendar_provider_type" RENAME TO "data_provider_type";
-- Add future provider types here as needed
