ALTER TABLE "devices" ADD COLUMN "expected_display_state" text DEFAULT 'on' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "expected_device_state" text DEFAULT 'awake' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "expected_wake_at" timestamp;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_expected_display_state_check" CHECK ("devices"."expected_display_state" IN ('on', 'off'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_expected_device_state_check" CHECK ("devices"."expected_device_state" IN ('awake', 'sleep'));
