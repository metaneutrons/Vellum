// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

/**
 * Initialize serial console + Improv WiFi Serial.
 * Starts a background task that handles both protocols on the USB-UART.
 */
void vellum_serial_init(void);
