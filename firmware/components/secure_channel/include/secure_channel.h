// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file secure_channel.h
 * @brief Device-to-server key agreement and token decryption.
 *
 * Uses an X25519 keypair (persisted in NVS) for ECDH, HKDF-SHA256 to derive an
 * AES key, and AES-256-GCM to decrypt the device token issued by the backend.
 * Implemented on the PSA Crypto API.
 */
#pragma once

#include "esp_err.h"
#include <stddef.h>

/**
 * Ensure an X25519 keypair exists in NVS, generating one if absent, and copy
 * the base64-encoded public key into @p pub_b64_out (for the /hello request).
 *
 * @return ESP_OK on success; ESP_FAIL if key generation/export failed.
 */
esp_err_t secure_channel_ensure_keypair(char *pub_b64_out, size_t out_len);

/**
 * Decrypt a server-issued token: ECDH(our private, server public) →
 * HKDF-SHA256 → AES-256-GCM decrypt. All inputs are base64-encoded.
 *
 * @return malloc'd, NUL-terminated plaintext token (caller frees), or NULL.
 */
char *secure_channel_decrypt_token(const char *ciphertext_b64,
                                   const char *nonce_b64,
                                   const char *server_pub_b64);
