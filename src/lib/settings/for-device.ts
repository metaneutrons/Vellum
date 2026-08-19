// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Database-aware resolution for one display.
 *
 * Two entry points on purpose, because the hot path and the admin path want
 * different things:
 *
 *  - `settingsForDevice` is what `/render` and `/config` call on every poll. It
 *    reads the site only when the device has one, and it does NOT look up the
 *    workspace defaults. Those are still resolved lazily by the caller exactly
 *    where they were before, so a display with explicit assignments costs the
 *    same number of queries it did before sites existed.
 *  - `explainDeviceSettings` is for the admin UI, which is rendered rarely and
 *    can afford two more reads to show a complete picture including where each
 *    value came from.
 */
import { eq } from "drizzle-orm";
import { db, withDbRead } from "@/db";
import { refreshProfiles, sites, themes } from "@/db/schema";
import { resolveDeviceSettings, type ResolvedDeviceSettings } from "./device-settings";

/** The columns of a device row this resolution needs. */
export interface DeviceAssignments {
  siteId: string | null;
  timezone: string | null;
  refreshProfileId: string | null;
  themeId: string | null;
  contentInstanceId: string | null;
}

async function loadSite(siteId: string | null) {
  if (!siteId) return null;
  const [site] = await withDbRead(
    () => db.select().from(sites).where(eq(sites.id, siteId)).limit(1),
    "settings-get-site"
  );
  return site ?? null;
}

/** Site and device layers only. See the note above on why the defaults are absent. */
export async function settingsForDevice(
  device: DeviceAssignments
): Promise<ResolvedDeviceSettings> {
  const site = await loadSite(device.siteId);
  return resolveDeviceSettings({
    site: site
      ? {
          refreshProfileId: site.refreshProfileId,
          themeId: site.themeId,
          contentInstanceId: site.contentInstanceId,
          timezone: site.timezone,
        }
      : null,
    device: {
      refreshProfileId: device.refreshProfileId,
      themeId: device.themeId,
      contentInstanceId: device.contentInstanceId,
      timezone: device.timezone,
    },
  });
}

/**
 * The full picture for the admin UI, including the workspace defaults, so the
 * interface can say "theme from the site" or "profile from the workspace default"
 * rather than leaving an operator to infer it.
 */
export async function explainDeviceSettings(
  device: DeviceAssignments
): Promise<ResolvedDeviceSettings> {
  const [site, defaultProfile, defaultTheme] = await Promise.all([
    loadSite(device.siteId),
    withDbRead(
      () =>
        db
          .select({ id: refreshProfiles.id })
          .from(refreshProfiles)
          .where(eq(refreshProfiles.isDefault, true))
          .limit(1),
      "settings-get-default-profile"
    ),
    withDbRead(
      () => db.select({ id: themes.id }).from(themes).where(eq(themes.isDefault, true)).limit(1),
      "settings-get-default-theme"
    ),
  ]);

  return resolveDeviceSettings({
    /* Content has no workspace default: there is no is_default on
     * content_instances, and inventing one here would claim a fallback the render
     * path does not actually have. A display with no content assigned answers 204. */
    workspace: {
      refreshProfileId: defaultProfile[0]?.id ?? null,
      themeId: defaultTheme[0]?.id ?? null,
    },
    site: site
      ? {
          refreshProfileId: site.refreshProfileId,
          themeId: site.themeId,
          contentInstanceId: site.contentInstanceId,
          timezone: site.timezone,
        }
      : null,
    device: {
      refreshProfileId: device.refreshProfileId,
      themeId: device.themeId,
      contentInstanceId: device.contentInstanceId,
      timezone: device.timezone,
    },
  });
}
