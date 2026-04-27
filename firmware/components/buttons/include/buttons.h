// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdint.h>

typedef enum {
    BUTTON_ACTION_NONE,
    BUTTON_ACTION_REQUEST_RENDER,
    BUTTON_ACTION_SEND_REPORT,
    BUTTON_ACTION_FACTORY_RESET,
} button_action_t;

void buttons_init(void);
button_action_t buttons_poll(void);
uint64_t buttons_get_wake_mask(void);
