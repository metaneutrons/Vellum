// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { eq } from "drizzle-orm";
import { db, withDbRead } from "@/db";
import { refreshProfiles } from "@/db/schema";
import { upgradeRefreshProfileConfig, type UnifiedRefreshProfile } from "@/lib/sleep";

/**
 * Resolve the profile used by a device in one place for every device endpoint.
 * Explicit device/site assignment wins, then the workspace default, then the
 * built-in policy represented by null.
 */
export async function resolveRefreshProfile(
  refreshProfileId: string | null
): Promise<UnifiedRefreshProfile | null> {
  if (refreshProfileId) {
    const [assigned] = await withDbRead(
      () =>
        db
          .select({ config: refreshProfiles.config })
          .from(refreshProfiles)
          .where(eq(refreshProfiles.id, refreshProfileId))
          .limit(1),
      "settings-get-refresh-profile"
    );
    if (assigned) return upgradeRefreshProfileConfig(assigned.config);
  }

  const [fallback] = await withDbRead(
    () =>
      db
        .select({ config: refreshProfiles.config })
        .from(refreshProfiles)
        .where(eq(refreshProfiles.isDefault, true))
        .limit(1),
    "settings-get-default-refresh-profile"
  );
  return fallback ? upgradeRefreshProfileConfig(fallback.config) : null;
}
