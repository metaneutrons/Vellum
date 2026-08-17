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

function parseWifiSsid(value: string | null): string | null {
  if (!value || value.length > 44 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0 || bytes.length > 32 || bytes.toString("base64") !== value) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseWifiSecurity(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && normalized.length <= 32 && /^[a-z0-9-]+$/.test(normalized)
    ? normalized
    : null;
}

function parseEnum<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && allowed.includes(value as T) ? (value as T) : null;
}

/**
 * Extract and validate bounded telemetry data from incoming request headers.
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
  const wifiSsid = headers.get("x-wifi-ssid-b64");
  const wifiSecurity = headers.get("x-wifi-security");
  const firmwareVersion = headers.get("x-firmware-ver");
  const securityProfile = headers.get("x-security-profile");
  const nvsIntegrity = headers.get("x-nvs-integrity");

  if (
    !batteryVoltage &&
    !batteryLevel &&
    !powerSource &&
    !batteryStatus &&
    !wifiRssi &&
    !wifiSsid &&
    !wifiSecurity &&
    !firmwareVersion &&
    !securityProfile &&
    !nvsIntegrity
  ) {
    return null;
  }

  const parsedPowerSource =
    powerSource === "usb" || powerSource === "battery" || powerSource === "unknown"
      ? powerSource
      : null;
  const parsedBatteryStatus =
    batteryStatus === "charging" ||
    batteryStatus === "full" ||
    batteryStatus === "discharging" ||
    batteryStatus === "unknown"
      ? batteryStatus
      : null;

  return {
    batteryVoltage: parseFiniteNumber(batteryVoltage, 0, 6),
    batteryLevel: parseBoundedInteger(batteryLevel, 0, 100),
    powerSource: parsedPowerSource,
    batteryStatus: parsedBatteryStatus,
    wifiRssi: parseBoundedInteger(wifiRssi, -127, 0),
    wifiSsid: parseWifiSsid(wifiSsid),
    wifiSecurity: parseWifiSecurity(wifiSecurity),
    firmwareVersion: firmwareVersion?.trim().slice(0, 64) || null,
    securityProfile: parseEnum(securityProfile, [
      "development",
      "testsecure",
      "secureboot",
      "production",
    ] as const),
    nvsIntegrity: parseEnum(nvsIntegrity, ["disabled", "valid", "invalid"] as const),
  };
}

/**
 * Log a telemetry entry to the database, associated with the given device MAC.
 */
export async function logTelemetry(entry: TelemetryEntry): Promise<void> {
  await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        await tx.insert(telemetry).values({
          mac: entry.mac,
          batteryVoltage: entry.batteryVoltage,
          batteryLevel: entry.batteryLevel,
          powerSource: entry.powerSource,
          batteryStatus: entry.batteryStatus,
          wifiRssi: entry.wifiRssi,
          wifiSsid: entry.wifiSsid,
          wifiSecurity: entry.wifiSecurity,
          firmwareVersion: entry.firmwareVersion,
          securityProfile: entry.securityProfile,
          nvsIntegrity: entry.nvsIntegrity,
          timestamp: entry.timestamp,
        });
        await tx
          .update(devices)
          .set({ lastSeen: entry.timestamp })
          .where(eq(devices.mac, entry.mac));
      }),
    "log-device-telemetry"
  );
}
