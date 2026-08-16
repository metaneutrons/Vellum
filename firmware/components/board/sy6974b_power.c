// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "sy6974b_power.h"

#include <stddef.h>

#define SY6974B_BUS_STAT_MASK  0xE0
#define SY6974B_BUS_STAT_SHIFT 5
#define SY6974B_BUS_OTG        0x07
#define SY6974B_POWER_GOOD     0x04
#define SY6974B_CHARGE_MASK    0x18
#define SY6974B_CHARGE_SHIFT   3

bool sy6974b_status_has_external_power(uint8_t status)
{
    uint8_t bus = (status & SY6974B_BUS_STAT_MASK) >> SY6974B_BUS_STAT_SHIFT;
    return (status & SY6974B_POWER_GOOD) != 0 && bus != 0 && bus != SY6974B_BUS_OTG;
}

sy6974b_charge_state_t sy6974b_status_charge_state(uint8_t status)
{
    return (sy6974b_charge_state_t)((status & SY6974B_CHARGE_MASK) >> SY6974B_CHARGE_SHIFT);
}

/* Official Seeed reTerminal E-Series ESPHome calibration, ordered from empty
 * to full. It reflects a Li-ion cell's nonlinear discharge curve; treating
 * 3.0-4.2 V as linear materially under-reports the useful middle range. */
typedef struct {
    int millivolts;
    int percent;
} battery_curve_point_t;

static const battery_curve_point_t s_battery_curve[] = {
    {3270, 0}, {3300, 5}, {3410, 10}, {3490, 20},
    {3580, 30}, {3680, 40}, {3750, 50}, {3800, 60},
    {3850, 70}, {3910, 80}, {3960, 90}, {4150, 100},
};

int e_series_battery_percent_from_mv(int millivolts)
{
    const size_t count = sizeof(s_battery_curve) / sizeof(s_battery_curve[0]);
    if (millivolts <= s_battery_curve[0].millivolts) return 0;

    for (size_t i = 1; i < count; ++i) {
        if (millivolts < s_battery_curve[i].millivolts) {
            const battery_curve_point_t lower = s_battery_curve[i - 1];
            const battery_curve_point_t upper = s_battery_curve[i];
            return lower.percent +
                   ((millivolts - lower.millivolts) * (upper.percent - lower.percent)) /
                       (upper.millivolts - lower.millivolts);
        }
    }
    return 100;
}
