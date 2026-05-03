/*
 * SPDX-FileCopyrightText: 2024 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * BF2253 register definitions.
 */
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/* bf2253 registers */
#define BF2253_REG_DELAY               0xfe
#define BF2253_REG_END                 0xff
#define BF2253_REG_SOFTWARE_STANDBY    0xf2
#define BF2253_REG_CHIP_ID_H           0xfc
#define BF2253_REG_CHIP_ID_L           0xfd
#define BF2253_REG_TEST_MODE           0x4a

#ifdef __cplusplus
}
#endif
