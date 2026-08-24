// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Fail when any locale deviates from the canonical English message schema. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const messagesDir = path.resolve("src/i18n/messages");
const sourceDir = path.resolve("src");
const canonicalFile = "en.json";
/**
 * Views whose human-facing literals are guarded.
 *
 * An ALLOWLIST, and its narrowness is a known weakness rather than a design: a
 * sweep on 2026-08-25 found 108 hard-coded strings across 26 view files, none of
 * them here, which is how the device detail page shipped eight English toasts and
 * four English connectivity labels while this check passed on every commit. Add a
 * file here the moment it is clean; the list only grows.
 */
const guardedUiFiles = [
  "src/app/admin/devices/[mac]/detail.tsx",
  "src/app/admin/profiles/profile-list.tsx",
  "src/app/admin/themes/theme-editor.tsx",
  "src/components/schedule-timeline.tsx",
];
const humanFacingAttributes = new Set([
  "alt",
  "aria-label",
  "cancelLabel",
  "confirmLabel",
  "description",
  "label",
  "message",
  "placeholder",
  "title",
]);

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

// These high-density editors previously accumulated English JSX and toast
// literals despite having complete locale schemas. Guard the human-facing
// literal shapes that schema parity cannot detect.
const hardcodedUiText = [];
/**
 * Prose, as opposed to a unit or a URL.
 *
 * "dBm", "1min" and "https://vellum.example.com" carry two letters and are
 * therefore words by the crude test, but none of them is translatable: a unit is
 * a unit in every locale here, and an example URL is a placeholder.
 */
const UNIT = /^\d*\s*(?:min|sec|s|h|ms|px|B|KB|MB|GB|V|mV|mA|dBm|%|°C)$/i;
const containsWords = (value) => {
  const text = value.trim();
  if (!/\p{L}{2}/u.test(text)) return false;
  return !UNIT.test(text) && !/^https?:\/\//i.test(text);
};
for (const relativeFile of guardedUiFiles) {
  const file = path.resolve(relativeFile);
  const sourceText = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const report = (node, value) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    hardcodedUiText.push(`${relativeFile}:${position.line + 1}: ${JSON.stringify(value.trim())}`);
  };
  const literal = (node) =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;

  function visit(node) {
    if (ts.isJsxText(node) && containsWords(node.text.trim())) report(node, node.text);
    if (
      ts.isJsxAttribute(node) &&
      humanFacingAttributes.has(node.name.getText(source)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      containsWords(node.initializer.text)
    ) {
      report(node.initializer, node.initializer.text);
    }
    if (ts.isJsxExpression(node) && node.expression) {
      const value = literal(node.expression);
      if (value && containsWords(value)) report(node.expression, value);
    }
    /* `{ label: "Online" }` in a lookup table is neither JSX nor an attribute, so
     * every shape above walked past it. That is exactly how four connectivity
     * labels stayed English next to a locale file that already translated them. */
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      humanFacingAttributes.has(node.name.text)
    ) {
      const value = literal(node.initializer);
      if (value && containsWords(value)) report(node.initializer, value);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "toast" &&
      node.arguments[1]
    ) {
      const value = literal(node.arguments[1]);
      if (value && containsWords(value)) report(node.arguments[1], value);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (hardcodedUiText.length) {
  process.exitCode = 1;
  console.error("\nHard-coded user-facing text found in i18n-guarded views:");
  for (const issue of hardcodedUiText) console.error(`  ${issue}`);
}

if (!process.exitCode) console.log("i18n message schemas and static source usages are in sync.");
