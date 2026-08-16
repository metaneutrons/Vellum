// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Guard the retry/transaction contract for every direct Drizzle DB call. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const extensions = new Set([".ts", ".tsx"]);
const readMethods = new Set(["select", "selectDistinct", "execute"]);
const writeMethods = new Set(["insert", "update", "delete"]);
const wrappers = {
  read: new Set(["withDbRead", "withDbTransaction", "withAuditedTransaction"]),
  write: new Set(["withDbWrite", "withDbTransaction", "withAuditedTransaction"]),
  transaction: new Set(["withDbTransaction"]),
};

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : extensions.has(extname(path)) ? [path] : [];
  });
}

function calleeName(node) {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function enclosingWrapper(node, allowed) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent)) {
      const name = calleeName(parent);
      if (name && allowed.has(name)) return name;
    }
    if (ts.isSourceFile(parent)) break;
  }
  return null;
}

const violations = [];
for (const file of files(SRC)) {
  if (file === join(SRC, "db", "index.ts")) continue;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "db"
    ) {
      const method = node.expression.name.text;
      const kind = readMethods.has(method)
        ? "read"
        : writeMethods.has(method)
          ? "write"
          : method === "transaction"
            ? "transaction"
            : null;
      if (kind && !enclosingWrapper(node, wrappers[kind])) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(
          `${relative(ROOT, file)}:${position.line + 1} db.${method} must be enclosed by ${[...wrappers[kind]].join(" or ")}`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (violations.length) {
  console.error(
    "✖ database access contract violations:\n" + violations.map((line) => `  ${line}`).join("\n")
  );
  process.exit(1);
}

process.stdout.write(
  "✔ every direct database call uses an explicit read, write, or transaction boundary.\n"
);
