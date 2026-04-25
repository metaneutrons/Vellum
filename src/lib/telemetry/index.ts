import { db } from "@/db";
import { telemetry, devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { TelemetryEntry } from "@/lib/types";

/**
 * Extract telemetry data from incoming request headers.
 * Returns a partial TelemetryEntry (without mac/timestamp) or null if no telemetry headers are present.
 */
export function extractTelemetry(
  headers: Headers
): Omit<TelemetryEntry, "mac" | "timestamp"> | null {
  const batteryVoltage = headers.get("x-battery-voltage");
  const batteryLevel = headers.get("x-battery-level");
  const wifiRssi = headers.get("x-wifi-rssi");
  const firmwareVersion = headers.get("x-firmware-ver");

  if (!batteryVoltage && !batteryLevel && !wifiRssi && !firmwareVersion) {
    return null;
  }

  return {
    batteryVoltage: batteryVoltage ? parseFloat(batteryVoltage) : 0,
    batteryLevel: batteryLevel ? parseInt(batteryLevel, 10) : 0,
    wifiRssi: wifiRssi ? parseInt(wifiRssi, 10) : 0,
    firmwareVersion: firmwareVersion ?? "",
  };
}

/**
 * Log a telemetry entry to the database, associated with the given device MAC.
 */
export async function logTelemetry(entry: TelemetryEntry): Promise<void> {
  await Promise.all([
    db.insert(telemetry).values({
      mac: entry.mac,
      batteryVoltage: entry.batteryVoltage,
      batteryLevel: entry.batteryLevel,
      wifiRssi: entry.wifiRssi,
      firmwareVersion: entry.firmwareVersion,
      timestamp: entry.timestamp,
    }),
    db.update(devices).set({ lastSeen: entry.timestamp }).where(eq(devices.mac, entry.mac)),
  ]);
}
