import { getAllFirmwareChannels, getAllDevices } from "../actions";
import { FirmwarePage } from "./firmware-page";

export default async function Page() {
  const [channels, deviceList] = await Promise.all([
    getAllFirmwareChannels(),
    getAllDevices(),
  ]);
  return <FirmwarePage channels={channels} devices={deviceList} />;
}
