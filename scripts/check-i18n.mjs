// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Fail when any locale deviates from the canonical English message schema. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const messagesDir = path.resolve("src/i18n/messages");
const canonicalFile = "en.json";

function flatten(value, prefix = "", keys = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, fullKey, keys);
    else keys.add(fullKey);
  }
  return keys;
}

function load(file) {
  try {
    return flatten(JSON.parse(fs.readFileSync(path.join(messagesDir, file), "utf8")));
  } catch (error) {
    console.error(`Unable to parse ${file}:`, error);
    process.exitCode = 1;
    return new Set();
  }
}

const canonical = load(canonicalFile);
for (const file of fs.readdirSync(messagesDir).filter((name) => name.endsWith(".json")).sort()) {
  const keys = load(file);
  const missing = [...canonical].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !canonical.has(key));
  if (missing.length || extra.length) {
    process.exitCode = 1;
    console.error(`\n${file} is not in sync with ${canonicalFile}.`);
    if (missing.length) console.error(`  Missing: ${missing.join(", ")}`);
    if (extra.length) console.error(`  Extra: ${extra.join(", ")}`);
  }
}

if (!process.exitCode) console.log("i18n message schemas are in sync.");
