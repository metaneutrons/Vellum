#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Assert that `src/db/schema.ts` is fully captured by `drizzle/meta/`.
 *
 * This is the parity check drizzle-kit itself performs, used as a gate: if the
 * model has drifted ahead of the newest snapshot, `drizzle-kit generate` would
 * emit a migration, and that migration is exactly what someone forgot to commit.
 *
 * It complements `check-schema-migrations.mjs` rather than replacing it. That
 * script compares the model against the SQL that actually runs, in one
 * direction and only for columns. This one compares the model against drizzle's
 * own snapshot of it, covering everything the snapshot format understands:
 * indexes and their predicates, CHECK constraints, foreign-key actions and
 * names, primary keys, defaults and nullability. Neither sees triggers or
 * plpgsql functions, which the format cannot represent at all.
 *
 * Runs generate against a COPY of `drizzle/meta/` in a temporary directory, so a
 * failing check never mutates the repository. The emitted SQL is printed,
 * because it is the migration the author needs.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCHEMA = join(ROOT, "src", "db", "schema.ts");

/* Must live inside the repo and be passed as a relative path: drizzle-kit
 * resolves --out by prefixing "./", so an absolute path becomes ".//tmp/…" and
 * the run dies while still exiting 0. Kept out of git by .gitignore, and removed
 * in the finally block below. */
const relWork = `.drizzle-parity-${randomUUID().slice(0, 8)}`;
const work = join(ROOT, relWork);

/* Every exit goes through the return value rather than process.exit(): calling
 * process.exit() inside the try would terminate immediately and skip the finally,
 * leaving the temporary directory behind on every run. */
function run() {
  // generate reads meta/_journal.json for the next index and the snapshots to
  // diff against; it writes any new .sql plus a snapshot into the same folder.
  mkdirSync(work, { recursive: true });
  cpSync(join(ROOT, "drizzle", "meta"), join(work, "meta"), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "drizzle-kit", "bin.cjs"),
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      SCHEMA,
      "--out",
      relWork,
      "--name",
      "parity_check",
    ],
    { cwd: ROOT, encoding: "utf8" }
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const emitted = readdirSync(work).filter((f) => f.endsWith(".sql"));

  /* Fail closed on an indeterminate run. drizzle-kit can abort on an internal
   * error and still exit 0, and a crash produces neither a migration nor the
   * no-changes banner — which must not be mistaken for "the model is clean". */
  if (emitted.length === 0 && !/No schema changes/i.test(output)) {
    console.error(
      "✖ snapshot guard: drizzle-kit generate produced neither a migration nor a\n" +
        "  no-changes result, so parity could not be determined.\n\n" +
        output.replace(/^/gm, "  ")
    );
    return 1;
  }

  if (emitted.length === 0) {
    console.log("✔ snapshot guard: src/db/schema.ts matches drizzle/meta/ — no migration pending.");
    return 0;
  }

  console.error(
    "✖ snapshot guard: src/db/schema.ts has changes that drizzle/meta/ does not\n" +
      "  describe, so the model is ahead of the migrations.\n"
  );
  for (const file of emitted) {
    console.error(`  ── drizzle-kit would emit ${file} ─────────────────────`);
    console.error(
      readFileSync(join(work, file), "utf8")
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
  }
  console.error(
    "\n  Commit that migration: run `pnpm db:generate`, review the SQL it writes\n" +
      "  into drizzle/ (it is applied by scripts/migrate.mjs, not by drizzle-kit),\n" +
      "  and commit it together with the updated drizzle/meta/ snapshot.\n\n" +
      "  For objects drizzle cannot express — triggers, plpgsql functions, DML —\n" +
      "  use `pnpm exec drizzle-kit generate --custom --name <desc>` instead and\n" +
      "  write the SQL by hand; that still records a snapshot and journal entry.\n"
  );
  return 1;
}

try {
  process.exitCode = run();
} finally {
  rmSync(work, { recursive: true, force: true });
}
