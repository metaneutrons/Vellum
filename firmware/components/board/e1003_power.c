// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "e1003_power.h"

#define SY6974B_BUS_STAT_MASK  0xE0
#define SY6974B_BUS_STAT_SHIFT 5
#define SY6974B_BUS_OTG        0x07
#define SY6974B_POWER_GOOD     0x04

bool e1003_charger_status_has_external_power(uint8_t status)
{
    uint8_t bus = (status & SY6974B_BUS_STAT_MASK) >> SY6974B_BUS_STAT_SHIFT;
    return (status & SY6974B_POWER_GOOD) != 0 && bus != 0 && bus != SY6974B_BUS_OTG;
}
