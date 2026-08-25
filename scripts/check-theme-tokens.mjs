// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Fail when a view paints itself from Tailwind's raw palette instead of the
 * Aurora tokens.
 *
 * The tokens in `globals.css` adapt: `.dark` on `<html>` redefines every one of
 * them, and the theme toggle defaults to `system`, so most operators see the dark
 * set. A class like `bg-gray-50` or `text-gray-500` does NOT adapt, so a view
 * built from them is a light view sitting on a dark page. That is not theoretical:
 * the device detail page held 66 of the 119 raw palette classes in the whole UI,
 * its log block named a background and no foreground at all, and the text was
 * unreadable.
 *
 * A BUDGET rather than a ban, for the same reason the coverage thresholds are a
 * ratchet: 53 occurrences remain across other views, and a gate that fails today
 * would simply be switched off. Each file may keep the count recorded here and no
 * more. Lower a number when you clean a file; the gate fails if you raise one.
 *
 * `border` with no colour counts too. Tailwind resolves it to `currentColor`,
 * which takes the text colour, so an uncoloured border is near-white in dark mode
 * and dark in light mode, and never the separator token.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const viewDirs = ["src/app", "src/components"];

/**
 * Surfaces that are deliberately NOT adaptive, each with the reason.
 *
 * Distinct from a budget: a budget is debt and is meant to reach zero, while
 * these are decisions. The count is still pinned, so the exception cannot quietly
 * grow into a licence for the whole file.
 */
const DELIBERATE = {
  "src/components/db-disconnect-overlay.tsx": {
    count: 9,
    why: "a blocking full-viewport alert over a blurred backdrop, dark in both themes on purpose; the colours that carry meaning already use the tokens",
  },
};

/**
 * Files still painting from the raw palette, with what they hold today.
 *
 * Every entry is a debt, not a permission. The intent is that this table only
 * ever shrinks; deleting an entry once a file is clean is the last step of
 * cleaning it. It is empty, and the aim is to keep it that way.
 */
const BUDGET = {};

const PALETTE =
  /\b(?:text|bg|border|ring|divide|from|to|via|outline|shadow|accent|caret|fill|stroke)-(?:gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

function views(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : views(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

const counts = new Map();
for (const dir of viewDirs) {
  for (const file of views(path.resolve(dir))) {
    const relative = path.relative(process.cwd(), file);
    const hits = (fs.readFileSync(file, "utf8").match(PALETTE) ?? []).length;
    if (hits > 0) counts.set(relative, hits);
  }
}

const allowanceOf = (file) => BUDGET[file] ?? DELIBERATE[file]?.count ?? 0;

let failed = false;
for (const [file, hits] of [...counts].sort()) {
  const allowed = allowanceOf(file);
  if (hits > allowed) {
    failed = true;
    console.error(
      allowed === 0
        ? `${file}: ${hits} raw palette class(es); use the Aurora tokens (text-label, bg-surface, border-separator, text-red …)`
        : `${file}: ${hits} raw palette classes, budget is ${allowed}. The budget may shrink, never grow.`
    );
  }
}

/* A budget for a file that no longer needs one is stale bookkeeping, and stale
 * bookkeeping is how an allowlist quietly becomes permanent. */
for (const [file, allowed] of [
  ...Object.entries(BUDGET),
  ...Object.entries(DELIBERATE).map(([f, d]) => [f, d.count]),
]) {
  const hits = counts.get(file) ?? 0;
  if (hits < allowed) {
    failed = true;
    console.error(
      `${file}: down to ${hits} from a budget of ${allowed}. Lower the budget in scripts/check-theme-tokens.mjs to lock the gain in.`
    );
  }
}

if (failed) {
  process.exitCode = 1;
  console.error("\nAurora tokens live in src/app/globals.css and adapt to dark mode; the raw");
  console.error("Tailwind palette does not. See scripts/check-theme-tokens.mjs for the why.");
} else {
  const debt = Object.keys(BUDGET).length;
  const kept = Object.values(DELIBERATE).reduce((a, d) => a + d.count, 0);
  console.log(
    debt === 0
      ? `Views use the Aurora tokens. No debt; ${kept} class(es) kept deliberately on non-adaptive surfaces.`
      : `Views use the Aurora tokens; ${debt} file(s) still carry a budget.`
  );
}
