// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAllDevices, getAvailableVersions, getRolloutOverview } from "../actions";
import { getAllSettings } from "@/lib/settings";
import { FirmwarePage } from "./firmware-page";
import { RolloutPanel } from "./rollout-panel";
import { getCurrentPrincipal, hasPermission } from "@/lib/access";
import { getServerUpdateStatus } from "@/lib/server-updater";

// Live fleet/rollout state — never serve a stale cached snapshot.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [deviceList, versions, settings, overview, principal, serverUpdate] = await Promise.all([
    getAllDevices(),
    getAvailableVersions(),
    getAllSettings(),
    getRolloutOverview(),
    getCurrentPrincipal(),
    getServerUpdateStatus(),
  ]);
  return (
    <div className="mx-auto max-w-5xl">
      <FirmwarePage devices={deviceList} versions={versions} settings={settings}
        serverUpdate={serverUpdate} canUpdateServer={hasPermission(principal, "system.update")} />
      <RolloutPanel overview={overview} versions={versions} />
    </div>
  );
}
