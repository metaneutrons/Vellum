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
  firmwareVersion: string | null;
  timestamp: Date;
}
