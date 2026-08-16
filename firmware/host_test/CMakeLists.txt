# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#
# Host-native firmware-logic tests. Deliberately NOT an ESP-IDF `linux`-target
# project: it builds with a plain host compiler + system OpenSSL so it runs in
# seconds on any runner (no ESP-IDF toolchain/container) and is verifiable
# locally. It covers the pure-logic contracts that are cheap to get wrong and
# expensive in the field — OTA version comparison, Ed25519 signature verify, and
# the X25519/HKDF/AES-GCM token channel — using golden vectors shared with the
# server. See README.md.
cmake_minimum_required(VERSION 3.16)
project(vellum_firmware_host_test C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

find_package(OpenSSL REQUIRED)

add_compile_options(-Wall -Wextra -Werror -O1)

add_executable(host_tests
  test_main.c
  test_version_compare.c
  test_ota_signature.c
  test_ota_model_guard.c
  test_secure_channel.c
  test_key_revocation.c
  test_sy6974b_power.c
  test_transport_policy.c
  test_wifi_failure.c
  test_render_backoff.c
  test_response_headers.c
  test_status_layout.c
  test_lcd_rotation.c
  test_d1001_power.c
  version_compare.c
  revocation.c
  ../components/board/sy6974b_power.c
  ../components/http_client/transport_policy.c
  ../components/http_client/response_headers.c
  ../components/wifi_manager/wifi_failure.c
  ../components/sleep_manager/render_backoff.c
  ../components/vellum_display/status_layout.c
  ../components-lcd/d1001_board/d1001_power_logic.c
)
target_include_directories(host_tests PRIVATE
  ../components/board/include
  ../components/http_client/include
  ../components/ota_manager/include
  ../components/wifi_manager/include
  ../components/vellum_display/include
  ../components/sleep_manager/include)
target_include_directories(host_tests PRIVATE ../components-lcd/d1001_board/include)
target_link_libraries(host_tests PRIVATE OpenSSL::Crypto)

enable_testing()
add_test(NAME firmware_host_tests COMMAND host_tests)
set_tests_properties(firmware_host_tests PROPERTIES FAIL_REGULAR_EXPRESSION "FAIL")
