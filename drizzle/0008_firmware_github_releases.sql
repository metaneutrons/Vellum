-- Drop firmware_channels FK from devices, add firmware_channel text column
ALTER TABLE "devices" DROP COLUMN IF EXISTS "firmware_channel_id";
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "firmware_channel" text DEFAULT 'stable';

-- Drop firmware_channels table
DROP TABLE IF EXISTS "firmware_channels";
