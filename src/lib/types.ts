// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
export type RoomPolicy = "Show All" | "Hide Subject" | "Hide All";
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
  batteryVoltage: number;
  batteryLevel: number;
  wifiRssi: number;
  firmwareVersion: string;
  timestamp: Date;
}
