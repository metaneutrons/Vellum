// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    SY6974B_CHARGE_NOT_CHARGING = 0,
    SY6974B_CHARGE_PRECHARGE,
    SY6974B_CHARGE_FAST,
    SY6974B_CHARGE_DONE,
} sy6974b_charge_state_t;

/** Decode SY6974B REG08 and report validated external input power. */
bool sy6974b_status_has_external_power(uint8_t status);

/** Decode CHRG_STAT[1:0] from the read-only SY6974B REG08 register. */
sy6974b_charge_state_t sy6974b_status_charge_state(uint8_t status);

/** Convert an E-Series cell voltage to percent using Seeed's calibration. */
int e_series_battery_percent_from_mv(int millivolts);
