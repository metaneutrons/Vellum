import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/db";
import { devices, telemetry, reports } from "@/db/schema";
import { DeviceDetail } from "./detail";
import { getAllThemes, getAllContentInstances, getAllRefreshProfiles } from "../../actions";

export default async function DeviceDetailPage({
  params,
}: {
  params: Promise<{ mac: string }>;
}) {
  const { mac } = await params;

  const [device] = await db.select().from(devices).where(eq(devices.mac, mac)).limit(1);
  if (!device) notFound();

  const [recentTelemetry, recentReports, themeList, contentList, profileList] = await Promise.all([
    db.select().from(telemetry).where(eq(telemetry.mac, mac)).orderBy(desc(telemetry.timestamp)).limit(50),
    db.select().from(reports).where(eq(reports.mac, mac)).orderBy(desc(reports.timestamp)).limit(10),
    getAllThemes(),
    getAllContentInstances(),
    getAllRefreshProfiles(),
  ]);

  return (
    <div>
      <Link href="/admin/devices" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        ← Back to Devices
      </Link>
      <DeviceDetail
        device={device}
        telemetryHistory={recentTelemetry}
        recentReports={recentReports}
        themes={themeList}
        contentInstances={contentList}
        refreshProfiles={profileList}
      />
    </div>
  );
}
