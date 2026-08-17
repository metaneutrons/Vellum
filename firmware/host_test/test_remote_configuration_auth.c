// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"

#include <openssl/evp.h>
#include <stdint.h>
#include <string.h>

static const char MESSAGE[] =
    "vellum-remote-config-v1\n"
    "123e4567-e89b-12d3-a456-426614174000\n"
    "https://vellum.example.com";
static const uint8_t TOKEN[] =
    "0101010101010101010101010101010101010101010101010101010101010101";
static const uint8_t EXPECTED[32] = {
    0xc5, 0xce, 0x06, 0xdd, 0x38, 0xa4, 0x4b, 0xf7,
    0x08, 0x31, 0x6a, 0x97, 0x31, 0x11, 0x37, 0xc6,
    0x16, 0x08, 0x27, 0xbc, 0xb1, 0xb3, 0x70, 0x9c,
    0xef, 0xcb, 0xe5, 0xc5, 0x0c, 0x9c, 0x77, 0xcd,
};
static const char WIFI_MESSAGE[] =
    "vellum-remote-wifi-v1\n"
    "123e4567-e89b-12d3-a456-426614174000\n"
    "T2ZmaWNlIFdpRmk=\n"
    "Y29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZQ==";
static const uint8_t WIFI_EXPECTED[32] = {
    0x27, 0x4a, 0xc5, 0x0b, 0xac, 0xf2, 0x43, 0x4b,
    0xd6, 0x47, 0x1f, 0x9f, 0x05, 0xb8, 0x11, 0x70,
    0xf6, 0x34, 0x70, 0x38, 0x83, 0xb9, 0xe0, 0x05,
    0xa0, 0x17, 0xc3, 0x1d, 0x6c, 0xd0, 0xe3, 0xac,
};

static int sign_message(const char *message, uint8_t output[32])
{
    EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_HMAC, NULL, TOKEN,
                                                  sizeof(TOKEN) - 1);
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    size_t output_len = 32;
    int ok = key && ctx && EVP_DigestSignInit(ctx, NULL, EVP_sha256(), NULL, key) == 1 &&
             EVP_DigestSign(ctx, output, &output_len,
                            (const uint8_t *)message, strlen(message)) == 1 &&
             output_len == 32;
    EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(key);
    return ok;
}

void test_remote_configuration_matches_server_vector(void)
{
    uint8_t actual[32];
    TEST_ASSERT_TRUE(sign_message(MESSAGE, actual));
    TEST_ASSERT_EQUAL_MEMORY(EXPECTED, actual, sizeof(actual));
}

void test_remote_configuration_binds_target(void)
{
    uint8_t actual[32];
    TEST_ASSERT_TRUE(sign_message(
        "vellum-remote-config-v1\n"
        "123e4567-e89b-12d3-a456-426614174000\n"
        "https://other.example.com", actual));
    TEST_ASSERT_FALSE(memcmp(EXPECTED, actual, sizeof(actual)) == 0);
}

void test_remote_wifi_configuration_matches_server_vector(void)
{
    uint8_t actual[32];
    TEST_ASSERT_TRUE(sign_message(WIFI_MESSAGE, actual));
    TEST_ASSERT_EQUAL_MEMORY(WIFI_EXPECTED, actual, sizeof(actual));
}

void run_remote_configuration_auth_tests(void)
{
    RUN_TEST(test_remote_configuration_matches_server_vector);
    RUN_TEST(test_remote_configuration_binds_target);
    RUN_TEST(test_remote_wifi_configuration_matches_server_vector);
}
