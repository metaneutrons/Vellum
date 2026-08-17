// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Refuse to start `next dev` against a database that is behind `drizzle/`.
 *
 * Nothing else notices. The container migrates itself at boot
 * (`docker-entrypoint`), CI never touches a real database, and `next dev` just
 * connects — so a local database silently stays at whatever revision it reached
 * the last time someone ran `pnpm db:migrate`. Pulling a branch that adds a
 * migration is enough to desync it.
 *
 * The failure that follows is expensive to read: the missing relation surfaces
 * far from its cause, as a generic "instrumentation hook" error or a 500 from
 * whichever route first selects the new column. That happened with
 * `firmware_catalog_state` (migration 0017) against a database still at 0005 —
 * seventeen migrations behind, with no symptom until boot.
 *
 * Blocking rather than warning is deliberate: a warning printed before Next's
 * own banner scrolls past unread, which is how the desync went unnoticed. The
 * check only blocks on a *positive* answer from the database. Anything it cannot
 * determine (no DATABASE_URL, connection refused, no permission) is not an
 * error here — offline and database-less dev must keep working, and
 * `scripts/migrate.mjs` remains the only thing that may modify a schema.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const DRIZZLE_DIR = join(import.meta.dirname, "..", "drizzle");

if (process.env.VELLUM_SKIP_MIGRATION_CHECK === "1") process.exit(0);

const url = process.env.DATABASE_URL;
// No database configured is a legitimate state for a dev server: the app
// degrades on its own, and there is nothing to compare against.
if (!url) process.exit(0);

const files = readdirSync(DRIZZLE_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (files.length === 0) process.exit(0);

/* Short timeout: this runs in front of every `pnpm dev`, so an unreachable
 * database must cost a moment, not the connection default. */
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });

let applied;
try {
  await client.connect();
  const result = await client.query("SELECT name FROM __vellum_migrations");
  applied = new Set(result.rows.map((r) => r.name));
} catch (err) {
  /* 42P01 = the journal table itself is absent, i.e. a database that has never
   * been migrated. That IS a positive answer: everything is pending. Any other
   * failure means we could not determine the state, so stay out of the way. */
  if (err?.code === "42P01") {
    applied = new Set();
  } else {
    process.exit(0);
  }
} finally {
  await client.end().catch(() => {});
}

const pending = files.filter((f) => !applied.has(f));
if (pending.length === 0) process.exit(0);

const listed = pending.slice(0, 10);
console.error(
  `\n✖ database is ${pending.length} migration(s) behind drizzle/:\n` +
    listed.map((f) => `    ${f}`).join("\n") +
    (pending.length > listed.length ? `\n    … and ${pending.length - listed.length} more` : "") +
    "\n\n  Starting the dev server now would fail at the first query touching a\n" +
    "  missing table or column, far from this cause. Apply them first:\n\n" +
    "      pnpm db:migrate\n\n" +
    "  The runner is idempotent and self-baselining, so re-running it is safe.\n" +
    "  To start anyway: VELLUM_SKIP_MIGRATION_CHECK=1 pnpm dev\n"
);
process.exit(1);
