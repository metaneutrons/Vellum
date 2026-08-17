-- Keep GitHub release discovery out of latency-sensitive admin and device
-- requests.  One durable row stores the last-known-good snapshot and a bounded
-- refresh lease coordinates multiple Vellum server replicas.
CREATE TABLE IF NOT EXISTS "firmware_catalog_state" (
  "source" text PRIMARY KEY,
  "manifests" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "etag" text,
  "last_attempt_at" timestamp,
  "last_success_at" timestamp,
  "next_refresh_at" timestamp,
  "failure_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "lease_owner" text,
  "lease_until" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
