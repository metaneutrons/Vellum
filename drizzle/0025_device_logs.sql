-- Device diagnostics: log batches a device reports about itself.
--
-- Firmware logs used to live only on a live UART, so a display that wedged or
-- refused its frames had to be diagnosed with a cable attached at the exact
-- moment it happened. Twice in one day the evidence was gone before that was
-- possible.
--
-- Uploads are event-driven: a healthy display sends nothing. devices.log_verbose
-- raises a single device to report everything while an operator debugs it.
--
-- Unmodified drizzle-kit output. Re-runs are already safe: migrate.mjs wraps each
-- statement in a savepoint and treats duplicate_table/duplicate_object as
-- "already satisfied", so hand-adding IF NOT EXISTS would only make the generated
-- output less trustworthy.
CREATE TABLE "device_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"mac" text NOT NULL,
	"seq" integer NOT NULL,
	"lines" text NOT NULL,
	"byte_len" integer NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "log_verbose" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_logs" ADD CONSTRAINT "device_logs_mac_devices_mac_fk" FOREIGN KEY ("mac") REFERENCES "public"."devices"("mac") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_logs_mac_seq_idx" ON "device_logs" USING btree ("mac","seq");--> statement-breakpoint
CREATE INDEX "device_logs_mac_received_idx" ON "device_logs" USING btree ("mac","received_at");