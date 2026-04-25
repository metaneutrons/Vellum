-- Migration: 0002_device_public_key
-- Stores the device's X25519 public key for encrypted token delivery

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "public_key" text;
