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
// ── Hard-coded user-facing text ─────────────────────────────────────────────
//
// Every view is guarded. This used to be an allowlist of three files, and the
// consequence was measurable: a sweep on 2026-08-25 found 119 literals across 28
// views, none of them in the three, which is how the device detail page shipped
// eight English toasts and four English connectivity labels while this check
// passed on every commit.
//
// Structured like `scripts/check-theme-tokens.mjs`, on purpose, so the two gates
// read the same way: a NOT-PROSE filter for things no locale would translate,
// EXEMPT for whole files that should not be translated at all, and BUDGET for
// what is simply not done yet.

/**
 * Strings that are not prose, whatever they look like to a regular expression.
 *
 * Getting this wrong in either direction costs something. Too narrow and the gate
 * demands a German word for `docker compose pull`; too wide and a real sentence
 * slips through as "probably an identifier".
 */
const NOT_PROSE = [
  // A unit is a unit in every locale, and an example URL is a placeholder.
  /^\d*\s*(?:min|sec|s|h|ms|px|B|KB|MB|GB|V|mV|mA|dBm|%|°C)\b/i,
  /^https?:\/\//i,
  // The product, and the services it talks to. Brand names are not translated.
  /^(?:Vellum|GitHub|Microsoft 365|Google|iCal|anny\.co|Docker)\b/,
  // Endonyms in a language picker. Translating these defeats the picker: a reader
  // who cannot read the current language has to find their own in their own.
  /^(?:Deutsch|English|Français|Italiano|Español)$/,
  // Identifiers, examples and machine input.
  /^[a-z0-9._-]+@[a-z0-9.-]+$/i, // an example address
  /^(?:docker|make|pnpm|npm|git)\s/, // a command to copy
  /^[A-Za-z]+\/[A-Za-z_]+$/, // an IANA zone, e.g. Europe/Berlin
  /^\{[a-z_]+\}$/, // a template placeholder, e.g. {full_name}
  /^(?:stable|beta|dev)$/, // a firmware channel, used verbatim in the API
  /^&[a-z]+;/, // an HTML entity rather than a word
  /^prop\./, // a provider's own property path
];

/**
 * Views deliberately left untranslated, each with the reason.
 *
 * A whole-file exemption is a strong claim, so it has to say why. The check
 * requires a reason of some length for exactly that purpose.
 */
const EXEMPT = {
  "src/app/simulator/client.tsx":
    "a development-only tool; its page returns 404 unless NODE_ENV is development, so nobody outside a dev machine ever reads these strings",
  "src/components/door-sign-multi-editor.tsx":
    "editor for a retired content type, kept only as the starting point for a future free-form sign; translating it would spend effort on code on its way out (docs/door-sign-retirement.md)",
  "src/components/door-sign-editor.tsx":
    "editor for a retired content type, see door-sign-multi-editor above",
  "src/components/text-box-canvas.tsx":
    "the retired editors' canvas, see door-sign-multi-editor above",
  "src/app/global-error.tsx":
    "the root error boundary renders its own <html> and therefore REPLACES the layout that provides the messages; a translated string here would throw inside the handler for a crash",
  "src/components/theme-preview.tsx":
    "sample content inside a miniature of a rendered sign; a device renders in the CONTENT's locale rather than the operator's, so translating the sample would misrepresent what the panel shows",
};

const BUDGET = {};
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
const perFile = new Map();
/* Every view, minus the ones that are exempt with a reason. */
const guardedUiFiles = sourceFiles(sourceDir)
  .filter((file) => /\.tsx$/.test(file) && !file.includes("__tests__"))
  .map((file) => path.relative(process.cwd(), file))
  .filter((file) => !EXEMPT[file])
  .sort();
/** Prose, as opposed to a brand, an identifier, a unit or a command. */
const containsWords = (value) => {
  const text = value.trim();
  if (!/\p{L}{2}/u.test(text)) return false;
  return !NOT_PROSE.some((pattern) => pattern.test(text));
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
    perFile.set(relativeFile, (perFile.get(relativeFile) ?? 0) + 1);
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

/* An exemption without a reason is an allowlist wearing a disguise. */
for (const [file, why] of Object.entries(EXEMPT)) {
  if (!why || why.length < 40) {
    process.exitCode = 1;
    console.error(`\n${file} is exempt from the text check without a real reason.`);
  }
}

const overBudget = [...perFile].filter(([file, hits]) => hits > (BUDGET[file] ?? 0));
if (overBudget.length) {
  process.exitCode = 1;
  console.error("\nHard-coded user-facing text found in views:");
  for (const issue of hardcodedUiText) {
    const file = issue.slice(0, issue.indexOf(":"));
    if (overBudget.some(([f]) => f === file)) console.error(`  ${issue}`);
  }
}

/* Same ratchet as the theme gate: a gain nobody writes down gets spent again. */
for (const [file, allowed] of Object.entries(BUDGET)) {
  const hits = perFile.get(file) ?? 0;
  if (hits < allowed) {
    process.exitCode = 1;
    console.error(
      `\n${file}: down to ${hits} from a budget of ${allowed}. Lower it in scripts/check-i18n.mjs.`
    );
  }
}

if (!process.exitCode) console.log("i18n message schemas and static source usages are in sync.");
