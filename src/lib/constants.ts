// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/**
 * Application-wide constants serving as the Single Source of Truth (SSOT).
 */
export const DEVICE_CONSTANTS = {
  /** Battery percentage below which a low battery warning is shown */
  BATTERY_WARNING_THRESHOLD: 20,

  /** WiFi RSSI (dBm) below which a weak signal warning is shown */
  RSSI_WARNING_THRESHOLD: -70,

  /** Time in milliseconds without a check-in before a device is considered offline (1 hour) */
  OFFLINE_TIMEOUT_MS: 3600_000,
} as const;
