// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAllDevices, getAvailableVersions } from "../actions";
import { getAllSettings } from "@/lib/settings";
import { FirmwarePage } from "./firmware-page";

export default async function Page() {
  const [deviceList, versions, settings] = await Promise.all([
    getAllDevices(),
    getAvailableVersions(),
    getAllSettings(),
  ]);
  return <FirmwarePage devices={deviceList} versions={versions} settings={settings} />;
}
