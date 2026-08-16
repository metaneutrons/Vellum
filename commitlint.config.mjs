// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Release Please derives changelogs and version bumps from Conventional
 * Commits. Keep the standard vocabulary in one place for both the local hook
 * and CI; Commitlint's built-in defaults deliberately ignore Git merge commits.
 */
export default {
  extends: ["@commitlint/config-conventional"],
};
