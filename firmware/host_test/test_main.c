// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file test_main.c
 * @brief Host-test entry point — runs every firmware-logic suite.
 */
#include "unity_min.h"

UNITY_DEFINE_GLOBALS();

void run_version_compare_tests(void);
void run_ota_signature_tests(void);
void run_secure_channel_tests(void);
void run_key_revocation_tests(void);

int main(void)
{
    UNITY_BEGIN();
    run_version_compare_tests();
    run_ota_signature_tests();
    run_secure_channel_tests();
    run_key_revocation_tests();
    return UNITY_END();
}
