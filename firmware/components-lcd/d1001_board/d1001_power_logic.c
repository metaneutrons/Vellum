// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "d1001_power_logic.h"

#include <stddef.h>

/* Seeed Studio's D1001 BSP curve, sampled in 5% increments. A linear
 * 3.0-4.2 V conversion substantially under-reports the broad, flat part of a
 * Li-ion discharge curve and produced Vellum's persistent 37% reading. */
static const int s_percent_mv[] = {
    3262, 3390, 3467, 3554, 3619, 3659, 3686,
    3710, 3731, 3752, 3774, 3797, 3827, 3855,
    3880, 3901, 3915, 3934, 3958, 3978, 4047,
};

int d1001_battery_percent_from_mv(int millivolts)
{
    const size_t points = sizeof(s_percent_mv) / sizeof(s_percent_mv[0]);
    if (millivolts < s_percent_mv[0]) return 0;

    for (size_t i = 1; i < points; ++i) {
        if (millivolts < s_percent_mv[i]) {
            const int lower_pct = (int)(i - 1) * 5;
            const int span_mv = s_percent_mv[i] - s_percent_mv[i - 1];
            const int offset_mv = millivolts - s_percent_mv[i - 1];
            return lower_pct + (offset_mv * 5) / span_mv;
        }
    }
    return 100;
}

d1001_battery_status_t d1001_battery_status_from_signals(bool usb_powered,
                                                         bool charge_state_high)
{
    if (!usb_powered) return D1001_BATTERY_STATUS_DISCHARGING;
    return charge_state_high ? D1001_BATTERY_STATUS_FULL
                             : D1001_BATTERY_STATUS_CHARGING;
}

const char *d1001_battery_status_name(d1001_battery_status_t status)
{
    switch (status) {
    case D1001_BATTERY_STATUS_DISCHARGING: return "discharging";
    case D1001_BATTERY_STATUS_CHARGING: return "charging";
    case D1001_BATTERY_STATUS_FULL: return "full";
    default: return "unknown";
    }
}
