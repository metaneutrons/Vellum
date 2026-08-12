#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Schema/migration parity guard.
 *
 * Every column declared in `src/db/schema.ts` must be created by some file in
 * `drizzle/`. Nothing else enforces this: `scripts/migrate.mjs` applies the raw
 * `drizzle/*.sql` files, `tsc` only type-checks the Drizzle model, and the test
 * suite runs without Postgres — so a column added to the model but never given
 * a migration passes every existing gate and only fails in production, at the
 * first query that selects it.
 *
 * That is not hypothetical: `devices.orientation_override` shipped in
 * `feat(orientation)` with no migration and stayed broken for ~3 months. Fresh
 * databases lacked the column, which took out `/api/v1/ink/render` — the
 * endpoint every display polls.
 *
 * `pnpm db:generate` cannot be relied on to catch it either: `drizzle/meta/`
 * snapshots stop at 0005 while migrations run to 0010, and those snapshots
 * already list `orientation_override`, so drizzle-kit believes the column
 * exists and will never emit it. Migrations here are hand-written by
 * convention; this guard is what makes that convention safe.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "src", "db", "schema.ts");
const DRIZZLE_DIR = join(ROOT, "drizzle");

/* Drizzle column builders whose first string argument is the SQL column name. */
const COLUMN_BUILDERS = [
  "text", "uuid", "timestamp", "jsonb", "json", "integer", "boolean", "serial",
  "bigserial", "numeric", "real", "doublePrecision", "date", "time", "bigint",
  "smallint", "varchar", "char", "inet", "interval",
];

/* Columns intentionally absent from drizzle/*.sql, with justification. Keep
 * empty unless a column is genuinely provided outside the migration files. */
const ALLOWLIST = new Map([]);

const schemaSrc = readFileSync(SCHEMA, "utf8");

/* Strip comments so a commented-out column decl cannot demand a migration.
 * Blank the comment bodies in place rather than deleting them, so reported line
 * numbers still match the real src/db/schema.ts. */
const schemaCode = schemaSrc
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/^([ \t]*)\/\/.*$/gm, "$1");

const columnRe = new RegExp(
  String.raw`\b(?:${COLUMN_BUILDERS.join("|")})\(\s*["']([A-Za-z0-9_]+)["']`,
  "g",
);

const declared = new Map(); // column name -> line number (first occurrence)
for (const match of schemaCode.matchAll(columnRe)) {
  const name = match[1];
  if (declared.has(name)) continue;
  declared.set(name, schemaCode.slice(0, match.index).split("\n").length);
}

if (declared.size === 0) {
  console.error(
    `✖ schema guard: parsed 0 columns from ${SCHEMA}.\n` +
      "  The parser is broken (or schema.ts moved) — failing rather than passing vacuously.",
  );
  process.exit(1);
}

const sqlFiles = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).sort();
if (sqlFiles.length === 0) {
  console.error(`✖ schema guard: no .sql migrations found in ${DRIZZLE_DIR}.`);
  process.exit(1);
}
const sql = sqlFiles.map((f) => readFileSync(join(DRIZZLE_DIR, f), "utf8")).join("\n");

/* Word-boundary match so `id` does not spuriously match `content_instance_id`.
 * Matches both quoted ("col") and bare (col) spellings. */
const createdInSql = (col) =>
  new RegExp(String.raw`(?<![A-Za-z0-9_])"?${col}"?(?![A-Za-z0-9_])`).test(sql);

const missing = [...declared.entries()]
  .filter(([col]) => !createdInSql(col) && !ALLOWLIST.has(col))
  .sort((a, b) => a[1] - b[1]);

if (missing.length > 0) {
  console.error(
    `✖ schema guard: ${missing.length} column(s) in src/db/schema.ts have no migration in drizzle/:\n`,
  );
  for (const [col, line] of missing) {
    console.error(`    ${col}  (src/db/schema.ts:${line})`);
  }
  console.error(
    "\n  Fresh databases will NOT have these columns, and any query selecting one\n" +
      "  fails at runtime. Add a hand-written migration, e.g.:\n\n" +
      '      ALTER TABLE "<table>" ADD COLUMN IF NOT EXISTS "<column>" <type>;\n\n' +
      "  as drizzle/NNNN_<description>.sql (next free number). Do not rely on\n" +
      "  `pnpm db:generate` — drizzle/meta snapshots are stale by design here.\n",
  );
  process.exit(1);
}

console.log(
  `✔ schema guard: all ${declared.size} columns in src/db/schema.ts are covered by ` +
    `${sqlFiles.length} migration(s) in drizzle/.`,
);
