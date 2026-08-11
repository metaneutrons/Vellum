// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentPrincipal, hasPermission } from "@/lib/access";
import { getServerUpdateStatus } from "@/lib/server-updater";
import { ServerUpdatePanel } from "./server-update-panel";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  const [principal, status, t] = await Promise.all([
    getCurrentPrincipal(),
    getServerUpdateStatus(),
    getTranslations("system"),
  ]);
  if (!hasPermission(principal, "system.read") && !hasPermission(principal, "system.update")) redirect("/admin");

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">{t("title")}</h1>
        <p className="text-[15px] text-label-secondary mt-1.5">{t("description")}</p>
      </div>
      <ServerUpdatePanel initialStatus={status} canUpdate={hasPermission(principal, "system.update")} />
    </div>
  );
}
