import { getAllFirmwareChannels } from "../../actions";
import { FlashTool } from "./flash-tool";

export default async function FlashPage() {
  const channels = await getAllFirmwareChannels();
  return <FlashTool channels={channels} />;
}
