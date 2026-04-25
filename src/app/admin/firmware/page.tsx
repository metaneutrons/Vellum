import { getAllDevices, getAvailableVersions } from "../actions";
import { FirmwarePage } from "./firmware-page";

export default async function Page() {
  const [deviceList, versions] = await Promise.all([
    getAllDevices(),
    getAvailableVersions(),
  ]);
  return <FirmwarePage devices={deviceList} versions={versions} />;
}
