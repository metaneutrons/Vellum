// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db, withDbTransaction } from "@/db";
import { telemetry, devices } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { TelemetryEntry } from "@/lib/types";

function parseFiniteNumber(value: string | null, min: number, max: number): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseBoundedInteger(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/**
 * Extract telemetry data from incoming request headers.
 * Returns a partial TelemetryEntry (without mac/timestamp) or null if no telemetry headers are present.
 */
export function extractTelemetry(
  headers: Headers
): Omit<TelemetryEntry, "mac" | "timestamp"> | null {
  const batteryVoltage = headers.get("x-battery-voltage");
  const batteryLevel = headers.get("x-battery-level");
  const powerSource = headers.get("x-power-source");
  const batteryStatus = headers.get("x-battery-status");
  const wifiRssi = headers.get("x-wifi-rssi");
  const firmwareVersion = headers.get("x-firmware-ver");

  if (!batteryVoltage && !batteryLevel && !powerSource && !batteryStatus && !wifiRssi && !firmwareVersion) {
    return null;
  }

  const parsedPowerSource = powerSource === "usb" || powerSource === "battery"
    ? powerSource
    : null;
  const parsedBatteryStatus =
    batteryStatus === "charging" || batteryStatus === "full" ||
    batteryStatus === "discharging" || batteryStatus === "unknown"
      ? batteryStatus
      : null;

  return {
    batteryVoltage: parseFiniteNumber(batteryVoltage, 0, 6),
    batteryLevel: parseBoundedInteger(batteryLevel, 0, 100),
    powerSource: parsedPowerSource,
    batteryStatus: parsedBatteryStatus,
    wifiRssi: parseBoundedInteger(wifiRssi, -127, 0),
    firmwareVersion: firmwareVersion?.trim().slice(0, 64) || null,
  };
}

/**
 * Log a telemetry entry to the database, associated with the given device MAC.
 */
export async function logTelemetry(entry: TelemetryEntry): Promise<void> {
  await withDbTransaction(() => db.transaction(async (tx) => {
    await tx.insert(telemetry).values({
      mac: entry.mac,
      batteryVoltage: entry.batteryVoltage,
      batteryLevel: entry.batteryLevel,
      powerSource: entry.powerSource,
      batteryStatus: entry.batteryStatus,
      wifiRssi: entry.wifiRssi,
      firmwareVersion: entry.firmwareVersion,
      timestamp: entry.timestamp,
    });
    await tx.update(devices).set({ lastSeen: entry.timestamp }).where(eq(devices.mac, entry.mac));
  }), "log-device-telemetry");
}
