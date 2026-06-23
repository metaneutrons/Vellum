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
  // TODO(aurora): migrate this screen off legacy-skin.
  return <div className="legacy-skin"><FirmwarePage devices={deviceList} versions={versions} settings={settings} /></div>;
}
