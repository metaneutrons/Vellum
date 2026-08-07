// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Decode SY6974B REG08 and report validated external input power. */
bool e1003_charger_status_has_external_power(uint8_t status);
