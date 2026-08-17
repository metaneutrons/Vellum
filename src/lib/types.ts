// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { ROOM_POLICIES } from "./content/renderers/room-booking-types";

export type RoomPolicy = (typeof ROOM_POLICIES)[number];
export type DeviceStatus = "pending" | "approved" | "rejected";

/** Re-exported from calendar/types.ts — SSOT */
export type { CalendarEvent } from "./calendar/types";

export interface DisplayEvent {
  displaySubject: string;
  organizer: string;
  startTime: Date;
  endTime: Date;
  isPrivate: boolean;
  showLockIcon: boolean;
}

export interface ApiResponse<T> {
  status: "ok" | "error";
  data: T | null;
  error: string | null;
}

export interface TelemetryEntry {
  mac: string;
  batteryVoltage: number | null;
  batteryLevel: number | null;
  powerSource: "usb" | "battery" | "unknown" | null;
  batteryStatus: "charging" | "full" | "discharging" | "unknown" | null;
  wifiRssi: number | null;
  wifiSsid: string | null;
  wifiSecurity: string | null;
  firmwareVersion: string | null;
  securityProfile: "development" | "testsecure" | "secureboot" | "production" | null;
  nvsIntegrity: "disabled" | "valid" | "invalid" | null;
  chipModel: "esp32s3" | "esp32p4" | "unknown" | null;
  chipRevision: number | null;
  flashSizeBytes: number | null;
  partitionLayout: "e-series-v1" | "e-series-secure-v1" | "d1001-v1" | "unknown" | null;
  partitionFingerprint: string | null;
  partitionTableOffset: number | null;
  layoutVerified: boolean | null;
  secureBootEnabled: boolean | null;
  flashEncryptionEnabled: boolean | null;
  nvsEncryptionEnabled: boolean | null;
  timestamp: Date;
}
