// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAvailableVersions } from "../../actions";
import { FlashTool } from "./flash-tool";

export const dynamic = "force-dynamic";

export default async function FlashPage() {
  const versions = await getAvailableVersions();
  return <FlashTool versions={versions} />;
}
