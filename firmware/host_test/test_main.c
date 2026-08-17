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
void run_ota_model_guard_tests(void);
void run_secure_channel_tests(void);
void run_key_revocation_tests(void);
void run_sy6974b_power_tests(void);
void run_transport_policy_tests(void);
void run_wifi_failure_tests(void);
void run_render_backoff_tests(void);
void run_response_headers_tests(void);
void run_status_layout_tests(void);
void run_lcd_rotation_tests(void);
void run_d1001_power_tests(void);
void run_epaper_contrast_tests(void);
void run_display_cache_tests(void);

int main(void)
{
    UNITY_BEGIN();
    run_version_compare_tests();
    run_ota_signature_tests();
    run_ota_model_guard_tests();
    run_secure_channel_tests();
    run_key_revocation_tests();
    run_sy6974b_power_tests();
    run_transport_policy_tests();
    run_wifi_failure_tests();
    run_render_backoff_tests();
    run_response_headers_tests();
    run_status_layout_tests();
    run_lcd_rotation_tests();
    run_d1001_power_tests();
    run_epaper_contrast_tests();
    run_display_cache_tests();
    return UNITY_END();
}
