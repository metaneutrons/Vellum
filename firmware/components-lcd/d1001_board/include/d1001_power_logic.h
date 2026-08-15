// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>

/** Hardware-independent battery states reported by the D1001 power path. */
typedef enum {
    D1001_BATTERY_STATUS_UNKNOWN = 0,
    D1001_BATTERY_STATUS_DISCHARGING,
    D1001_BATTERY_STATUS_CHARGING,
    D1001_BATTERY_STATUS_FULL,
} d1001_battery_status_t;

/** Convert a calibrated cell voltage to state-of-charge using Seeed's measured
 * D1001 discharge curve. Values between the 5% knots are interpolated. */
int d1001_battery_percent_from_mv(int millivolts);

/** Decode the charger's active-low CHARGE_STATE output. A high level only means
 * "charge complete" while USB is present; without VBUS the cell is discharging. */
d1001_battery_status_t d1001_battery_status_from_signals(bool usb_powered,
                                                         bool charge_state_high);

const char *d1001_battery_status_name(d1001_battery_status_t status);
