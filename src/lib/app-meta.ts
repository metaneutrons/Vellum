// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/**
 * Static application metadata surfaced in the UI (footer / login screen).
 * `NEXT_PUBLIC_APP_VERSION` is inlined from package.json at build time via
 * next.config.ts; it falls back to "dev" when running outside a Next build.
 */
export const APP_NAME = "Vellum";
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

export const REPO_URL = "https://github.com/metaneutrons/Vellum";
/** Link to the GitHub release matching the running server version. */
export const RELEASE_URL =
  APP_VERSION === "dev" ? `${REPO_URL}/releases` : `${REPO_URL}/releases/tag/v${APP_VERSION}`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const LICENSE = "AGPL-3.0";
export const COPYRIGHT_YEAR = "2026";
export const COPYRIGHT_HOLDER = "Fabian Schmieder";
