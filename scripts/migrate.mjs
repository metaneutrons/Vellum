// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Idempotent database migration runner for Vellum.
 *
 * Applies `drizzle/*.sql` in order and records each in `__vellum_migrations`, so
 * re-running is a cheap no-op. Deliberately NOT `drizzle-kit migrate`: the
 * databases here were originally created with `drizzle-kit push`, so drizzle's
 * own journal is empty and `migrate` would try to replay 0000… against existing
 * tables and fail. This runner therefore SELF-BASELINES — a statement that fails
 * because its object already exists (a set of benign SQLSTATEs) is treated as
 * already-applied instead of an error, so a pre-existing DB is adopted cleanly
 * and only genuinely-new statements run.
 *
 * Reads DATABASE_URL from the environment (the container already has it; for
 * local dev the npm script loads .env via --env-file-if-exists).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const DRIZZLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

// SQLSTATEs that mean "this object already exists" → the statement is already
// satisfied by the current schema; record the migration rather than failing.
const ALREADY_EXISTS = new Set([
  "42701", // duplicate_column
  "42P07", // duplicate_table
  "42710", // duplicate_object (constraint, etc.)
  "42P06", // duplicate_schema
  "42723", // duplicate_function
  "42P16", // invalid_table_definition (e.g. re-adding a PK)
  "42704", // undefined_object (dropping something already gone)
]);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(
    `CREATE TABLE IF NOT EXISTS __vellum_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const done = new Set(
    (await client.query("SELECT name FROM __vellum_migrations")).rows.map((r) => r.name),
  );
  const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).sort();

  let applied = 0;
  let baselined = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
    // drizzle separates statements with a `--> statement-breakpoint` marker.
    const statements = sql
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);

    let ran = 0;
    let skipped = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        ran++;
      } catch (err) {
        if (ALREADY_EXISTS.has(err.code)) {
          skipped++; // object already present — pre-existing schema
        } else {
          console.error(`migrate: FAILED in ${file} [${err.code}]: ${err.message}`);
          throw err;
        }
      }
    }
    await client.query(
      "INSERT INTO __vellum_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING",
      [file],
    );
    if (ran > 0) {
      applied++;
      console.log(`migrate: applied ${file} (${ran} statement(s)${skipped ? `, ${skipped} already present` : ""})`);
    } else {
      baselined++;
      console.log(`migrate: baselined ${file} (already present)`);
    }
  }
  console.log(`migrate: done — ${applied} applied, ${baselined} baselined, ${done.size} already tracked`);
} finally {
  await client.end();
}
