// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getDashboardData } from "./dashboard-data";
import { KpiCards } from "./dashboard/kpi-cards";
import { FleetStatus } from "./dashboard/fleet-status";
import { CheckinChart } from "./dashboard/checkin-chart";
import { FirmwarePanel } from "./dashboard/firmware-panel";
import { CatalogPanel } from "./dashboard/catalog-panel";
import { AttentionList } from "./dashboard/attention-list";
import { ActivityFeed } from "./dashboard/activity-feed";
import { getTranslations } from "next-intl/server";

// Live fleet data — never serve a stale cached snapshot.
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const t = await getTranslations("dashboard");
  const data = await getDashboardData();
  const now = Date.parse(data.generatedAt);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="text-[28px] font-semibold tracking-tight text-label">{t("overview")}</h1>
        <p className="text-label-secondary">{t("subtitle")}</p>
      </header>

      <div className="space-y-4">
        {/* Hero KPIs */}
        <KpiCards fleet={data.fleet} attentionCount={data.attention.length} />

        {/* Fleet donut + check-in trend */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <FleetStatus fleet={data.fleet} />
          <div className="lg:col-span-2">
            <CheckinChart checkins={data.checkins} />
          </div>
        </div>

        {/* Firmware · attention · activity */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <FirmwarePanel firmware={data.firmware} />
          <AttentionList devices={data.attention} now={now} />
          <ActivityFeed recent={data.recent} reports={data.reports} now={now} />
        </div>

        {/* Catalog */}
        <CatalogPanel catalog={data.catalog} />
      </div>
    </div>
  );
}
