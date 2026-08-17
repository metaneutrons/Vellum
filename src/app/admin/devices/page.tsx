// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getDeviceSnapshots } from "@/lib/device-snapshot";
import {
  getAllThemes,
  getAllContentInstances,
  getAllRefreshProfiles,
  getAvailableVersions,
  getAllProviders,
  getKnownDisplaySizes,
} from "../actions";
import { DeviceTable } from "./device-table";

export default async function DevicesPage() {
  const [themeList, contentList, profileList, versions, providers, knownDisplays] =
    await Promise.all([
      getAllThemes(),
      getAllContentInstances(),
      getAllRefreshProfiles(),
      getAvailableVersions(),
      getAllProviders(),
      getKnownDisplaySizes(),
    ]);

  // The container completes schema migrations before serving requests, so a
  // schema error must remain visible instead of being mistaken for an older DB.
  const deviceRows = await getDeviceSnapshots();

  return (
    <DeviceTable
      devices={deviceRows}
      themes={themeList}
      contentInstances={contentList}
      refreshProfiles={profileList}
      firmwareVersions={versions}
      providers={providers}
      knownDisplays={knownDisplays}
    />
  );
}
