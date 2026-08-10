-- Bind an intentional non-latest flash to the one device that claims its
-- zero-touch provisioning voucher. Nullable keeps existing vouchers unchanged.
ALTER TABLE "provisioning_vouchers" ADD COLUMN IF NOT EXISTS "firmware_channel" text;
ALTER TABLE "provisioning_vouchers" ADD COLUMN IF NOT EXISTS "firmware_pin_version" text;
