CREATE TABLE IF NOT EXISTS "provisioning_vouchers" (
	"token" text PRIMARY KEY NOT NULL,
	"label" text,
	"claimed_by_mac" text,
	"claimed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
