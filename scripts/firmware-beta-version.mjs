// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/**
 * Return the next patch prerelease above the currently released firmware.
 *
 * Release Please keeps Kconfig at the latest stable version until the next
 * release PR is merged. Reusing that version for post-release beta builds would
 * create e.g. 1.4.2-beta after stable 1.4.2, which SemVer correctly considers
 * older despite its later publication date.
 */
export function firmwareBetaVersion(stableVersion, betaNumber, shortSha) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stableVersion);
  if (!match) throw new Error(`invalid stable firmware version: ${stableVersion}`);
  if (!/^\d+$/.test(String(betaNumber))) throw new Error(`invalid beta number: ${betaNumber}`);
  if (!/^[0-9a-f]{7,40}$/i.test(shortSha)) throw new Error(`invalid git SHA: ${shortSha}`);

  const nextPatch = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
  const version = `${nextPatch}-beta.${betaNumber}+${shortSha}`;
  return { version, tag: `firmware-v${version.replace("+", "-")}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = firmwareBetaVersion(
    process.argv[2] ?? "",
    process.argv[3] ?? "",
    process.argv[4] ?? ""
  );
  process.stdout.write(`version=${result.version}\ntag=${result.tag}\n`);
}
