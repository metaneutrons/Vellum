// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { pathToFileURL } from "node:url";

/**
 * Classify a commit created by merging a Release Please component PR.
 *
 * Both GitHub's squash subject and the merge-commit branch marker are supported.
 * Matching is deliberately anchored/component-specific: an ordinary commit body
 * mentioning a release must never suppress a build or promote beta firmware.
 */
export function classifyReleaseCommit(message) {
  const subject = String(message ?? "").split(/\r?\n/, 1)[0];

  if (
    /^chore\((?:main|firmware)\): release firmware \d+\.\d+\.\d+(?: \(#\d+\))?$/.test(subject) ||
    /release-please--branches--main--components--firmware(?:\s|$)/.test(String(message ?? ""))
  ) {
    return "firmware";
  }

  if (
    /^chore\(main\): release(?: server)? \d+\.\d+\.\d+(?: \(#\d+\))?$/.test(subject) ||
    /release-please--branches--main--components--server(?:\s|$)/.test(String(message ?? ""))
  ) {
    return "server";
  }

  return "none";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${classifyReleaseCommit(process.argv[2])}\n`);
}
