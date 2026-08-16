// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Fail when any locale deviates from the canonical English message schema. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const messagesDir = path.resolve("src/i18n/messages");
const sourceDir = path.resolve("src");
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

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.[jt]sx?$/.test(entry.name) ? [fullPath] : [];
  });
}

const canonical = load(canonicalFile);
for (const file of fs
  .readdirSync(messagesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
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

// Schema parity alone cannot catch a key that is absent from every locale.
// Verify literal calls made through a statically namespaced translation hook
// against the canonical English catalogue as well.
const missingUsages = new Set();
for (const file of sourceFiles(sourceDir)) {
  const source = fs.readFileSync(file, "utf8");
  const bindingPattern =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*["']([^"']+)["']\s*\)/g;
  let binding;
  while ((binding = bindingPattern.exec(source)) !== null) {
    const [, translator, namespace] = binding;
    const callPattern = new RegExp(`\\b${translator}\\(\\s*["']([^"']+)["']`, "g");
    let call;
    while ((call = callPattern.exec(source)) !== null) {
      const fullKey = `${namespace}.${call[1]}`;
      if (!canonical.has(fullKey)) {
        missingUsages.add(`${path.relative(process.cwd(), file)}: ${fullKey}`);
      }
    }
  }
}

if (missingUsages.size) {
  process.exitCode = 1;
  console.error("\nTranslation keys used in source but missing from en.json:");
  for (const usage of [...missingUsages].sort()) console.error(`  ${usage}`);
}

if (!process.exitCode) console.log("i18n message schemas and static source usages are in sync.");
