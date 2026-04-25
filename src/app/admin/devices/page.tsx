import { getAllDevices, getAllThemes, getAllContentInstances, getAllRefreshProfiles } from "../actions";
import { DeviceTable } from "./device-table";

export default async function DevicesPage() {
  const [deviceList, themeList, contentList, profileList] = await Promise.all([
    getAllDevices(),
    getAllThemes(),
    getAllContentInstances(),
    getAllRefreshProfiles(),
  ]);

  return (
    <DeviceTable
      devices={deviceList}
      themes={themeList}
      contentInstances={contentList}
      refreshProfiles={profileList}
    />
  );
}
