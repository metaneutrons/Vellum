import { getAllDevices, getAllThemes, getAllContentInstances } from "../actions";
import { DeviceTable } from "./device-table";

export default async function DevicesPage() {
  const [deviceList, themeList, contentList] = await Promise.all([
    getAllDevices(),
    getAllThemes(),
    getAllContentInstances(),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Devices</h1>
      <DeviceTable
        devices={deviceList}
        themes={themeList}
        contentInstances={contentList}
      />
    </div>
  );
}
