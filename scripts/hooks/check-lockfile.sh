#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#
# Fail when a DEPENDENCY change in package.json is staged without the lockfile.
#
# The earlier form fired on any package.json edit at all, so changing a script, a
# version or a field pnpm never reads could not be committed without also staging
# a pnpm-lock.yaml that pnpm had no reason to rewrite. Only the fields pnpm
# resolves from are compared here.

staged=$(git diff --cached --name-only)

case "$staged" in
  *package.json*) ;;
  *) exit 0 ;;
esac

# Lockfile is coming along anyway — nothing to complain about.
case "$staged" in
  *pnpm-lock.yaml*) exit 0 ;;
esac

resolved_fields() {
  git show "$1" 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      const pkg = raw ? JSON.parse(raw) : {};
      const keys = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
        "peerDependenciesMeta",
        "overrides",
        "resolutions",
        "pnpm",
        "packageManager",
      ];
      const picked = {};
      for (const key of keys) if (pkg[key] !== undefined) picked[key] = pkg[key];
      process.stdout.write(JSON.stringify(picked));
    });'
}

before=$(resolved_fields "HEAD:package.json")
after=$(resolved_fields ":package.json")

if [ "$before" != "$after" ]; then
  echo "package.json dependencies changed, pnpm-lock.yaml did not. Run pnpm install." >&2
  exit 1
fi

exit 0
