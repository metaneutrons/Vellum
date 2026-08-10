// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { ProvisionTool } from "./provision-tool";

export const dynamic = "force-dynamic";

export default async function ProvisionPage({
  searchParams,
}: {
  searchParams: Promise<{ firmwareChannel?: string; firmwarePinVersion?: string }>;
}) {
  const params = await searchParams;
  const firmware =
    (params.firmwareChannel === "stable" || params.firmwareChannel === "beta") &&
    params.firmwarePinVersion &&
    /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(params.firmwarePinVersion)
      ? { channel: params.firmwareChannel as "stable" | "beta", version: params.firmwarePinVersion }
      : undefined;
  return <ProvisionTool firmware={firmware} />;
}
