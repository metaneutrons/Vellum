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
 * snapshots stop at 0005 while migrations run past 0010, and those snapshots
 * already list `orientation_override`, so drizzle-kit believes the column
 * exists and will never emit it. Migrations here are hand-written by
 * convention; this guard is what makes that convention safe.
 *
 * ── Why this compares TABLE + COLUMN, not bare column names ──────────
 *
 * The first version of this guard scraped column names from the whole schema
 * file, de-duplicated them, and asked whether each name appeared anywhere in the
 * concatenated SQL. Two consequences, both bad:
 *
 *   - A name reused on a second table was never checked at all — the first
 *     occurrence won and the rest were skipped. Of 161 table+column pairs in the
 *     model, only 81 distinct names were examined; 80 pairs went unchecked.
 *   - "Appears anywhere in the SQL" is satisfied by a different table's column,
 *     an index name, or a comment.
 *
 * So `refresh_profiles.is_default` was reported as covered purely because
 * `themes.is_default` had claimed the name back in 0000 — the exact class of
 * miss this guard exists to prevent, on a column added months after it. A future
 * `devices.name` or `themes.config` with no migration would have passed too.
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

/* Table-qualified columns intentionally absent from drizzle/*.sql, with
 * justification. Keys are "table.column". Keep empty unless a column is
 * genuinely provided outside the migration files. */
const ALLOWLIST = new Map([]);

/* Table-level constraint keywords: these open a definition inside CREATE TABLE
 * that is not a column. */
const CONSTRAINT_KEYWORDS = new Set([
  "primary", "unique", "foreign", "constraint", "check", "exclude", "like",
]);

/** Text of the balanced block starting at `open` (which must be an opener). */
function balanced(src, open, opener, closer) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === opener) depth++;
    else if (src[i] === closer) {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null; // unbalanced — caller treats as a parse failure
}

/* ── The model ───────────────────────────────────────────────────────── */

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

/** table -> Map(column -> line number in schema.ts) */
const declared = new Map();
const tableRe = /pgTable\(\s*["']([A-Za-z0-9_]+)["']\s*,\s*\{/g;
for (const match of schemaCode.matchAll(tableRe)) {
  const table = match[1];
  const open = schemaCode.indexOf("{", match.index + match[0].length - 1);
  const block = balanced(schemaCode, open, "{", "}");
  if (block === null) {
    console.error(`✖ schema guard: unbalanced braces in pgTable("${table}") — parser cannot continue.`);
    process.exit(1);
  }
  const columns = declared.get(table) ?? new Map();
  for (const col of block.matchAll(columnRe)) {
    const name = col[1];
    if (columns.has(name)) continue;
    const absolute = open + col.index;
    columns.set(name, schemaCode.slice(0, absolute).split("\n").length);
  }
  declared.set(table, columns);
}

const pairCount = [...declared.values()].reduce((n, cols) => n + cols.size, 0);
if (pairCount === 0) {
  console.error(
    `✖ schema guard: parsed 0 columns from ${SCHEMA}.\n` +
      "  The parser is broken (or schema.ts moved) — failing rather than passing vacuously.",
  );
  process.exit(1);
}

/* ── The migrations ──────────────────────────────────────────────────── */

const sqlFiles = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith(".sql")).sort();
if (sqlFiles.length === 0) {
  console.error(`✖ schema guard: no .sql migrations found in ${DRIZZLE_DIR}.`);
  process.exit(1);
}
const sql = sqlFiles.map((f) => readFileSync(join(DRIZZLE_DIR, f), "utf8")).join("\n");

/* Strip SQL comments: a column named in a comment must not count as created. */
const sqlCode = sql
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*--.*$/gm, "");

/** table -> Set(columns the migrations actually create) */
const createdBySql = new Map();
const add = (table, column) => {
  const set = createdBySql.get(table) ?? new Set();
  set.add(column);
  createdBySql.set(table, set);
};

/* CREATE TABLE [IF NOT EXISTS] "t" ( <definitions> ) */
const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z0-9_]+)"?\s*\(/gi;
for (const match of sqlCode.matchAll(createRe)) {
  const table = match[1];
  const open = sqlCode.indexOf("(", match.index + match[0].length - 1);
  const body = balanced(sqlCode, open, "(", ")");
  if (body === null) continue;
  /* Split on top-level commas only: a column's own type or DEFAULT may contain
   * parenthesised commas, e.g. numeric(10,2). */
  let depth = 0, item = "";
  const items = [];
  for (const ch of body.slice(1, -1)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(item); item = ""; }
    else item += ch;
  }
  items.push(item);
  for (const raw of items) {
    const first = raw.trim().match(/^"?([A-Za-z0-9_]+)"?/);
    if (!first) continue;
    if (CONSTRAINT_KEYWORDS.has(first[1].toLowerCase())) continue;
    add(table, first[1]);
  }
}

/* ALTER TABLE "t" ADD COLUMN [IF NOT EXISTS] "c" */
const alterRe =
  /alter\s+table\s+(?:if\s+exists\s+)?"?([A-Za-z0-9_]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z0-9_]+)"?/gi;
for (const match of sqlCode.matchAll(alterRe)) add(match[1], match[2]);

if (createdBySql.size === 0) {
  console.error(
    `✖ schema guard: parsed 0 tables from ${DRIZZLE_DIR}.\n` +
      "  The SQL parser is broken — failing rather than passing vacuously.",
  );
  process.exit(1);
}

/* ── Compare ─────────────────────────────────────────────────────────── */

const missing = [];   // { table, column, line }
const absentTables = [];
for (const [table, columns] of declared) {
  const created = createdBySql.get(table);
  if (!created) {
    absentTables.push({ table, line: Math.min(...columns.values()) });
    continue;
  }
  for (const [column, line] of columns) {
    if (created.has(column)) continue;
    if (ALLOWLIST.has(`${table}.${column}`)) continue;
    missing.push({ table, column, line });
  }
}
missing.sort((a, b) => a.line - b.line);
absentTables.sort((a, b) => a.line - b.line);

if (absentTables.length > 0 || missing.length > 0) {
  console.error("✖ schema guard: src/db/schema.ts declares database objects that drizzle/ never creates.\n");
  for (const { table, line } of absentTables) {
    console.error(`    table "${table}" has no CREATE TABLE  (src/db/schema.ts:${line})`);
  }
  for (const { table, column, line } of missing) {
    console.error(`    ${table}.${column}  (src/db/schema.ts:${line})`);
  }
  console.error(
    "\n  Fresh databases will NOT have these, and any query touching one fails at\n" +
      "  runtime. Add a hand-written migration, e.g.:\n\n" +
      '      ALTER TABLE "<table>" ADD COLUMN IF NOT EXISTS "<column>" <type>;\n\n' +
      "  as drizzle/NNNN_<description>.sql (next free number). Do not rely on\n" +
      "  `pnpm db:generate` — drizzle/meta snapshots are stale by design here.\n",
  );
  process.exit(1);
}

console.log(
  `✔ schema guard: all ${pairCount} columns across ${declared.size} tables in ` +
    `src/db/schema.ts are covered by ${sqlFiles.length} migration(s) in drizzle/.`,
);
