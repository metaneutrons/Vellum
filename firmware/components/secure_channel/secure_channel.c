// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file secure_channel.c
 * @brief X25519 ECDH + HKDF-SHA256 + AES-256-GCM via the PSA Crypto API.
 */

#include "secure_channel.h"

#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "psa/crypto.h"
#include "mbedtls/base64.h"
#include "mbedtls/platform_util.h"
#include "nvs_manager.h"

static const char *TAG = "secure_channel";

esp_err_t secure_channel_ensure_keypair(char *pub_b64_out, size_t out_len)
{
    if (nvs_manager_has_keypair() &&
        nvs_manager_get_public_key(pub_b64_out, out_len) == ESP_OK) {
        ESP_LOGI(TAG, "Loaded existing X25519 keypair");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Generating X25519 keypair...");

    psa_status_t status = psa_crypto_init();
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "PSA crypto init failed: %d", (int)status);
        return ESP_FAIL;
    }

    psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_DERIVE | PSA_KEY_USAGE_EXPORT);
    psa_set_key_algorithm(&attr, PSA_ALG_ECDH);
    psa_set_key_type(&attr, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_MONTGOMERY));
    psa_set_key_bits(&attr, 255);

    psa_key_id_t key_id;
    status = psa_generate_key(&attr, &key_id);
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Key generation failed: %d", (int)status);
        return ESP_FAIL;
    }

    /* Export private key (raw 32 bytes) */
    uint8_t priv_raw[32];
    size_t priv_len;
    psa_status_t exp_priv = psa_export_key(key_id, priv_raw, sizeof(priv_raw), &priv_len);

    /* Export public key (raw 32 bytes) */
    uint8_t pub_raw[32];
    size_t pub_len;
    psa_status_t exp_pub = psa_export_public_key(key_id, pub_raw, sizeof(pub_raw), &pub_len);

    psa_destroy_key(key_id);

    if (exp_priv != PSA_SUCCESS || exp_pub != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Key export failed: priv=%d pub=%d", (int)exp_priv, (int)exp_pub);
        return ESP_FAIL; /* Never store/transmit an uninitialized key */
    }

    /* Base64 encode */
    char priv_b64[NVS_MAX_KEY_LEN];
    size_t priv_b64_len = 0, pub_b64_len = 0;
    int e1 = mbedtls_base64_encode((unsigned char *)priv_b64, sizeof(priv_b64), &priv_b64_len, priv_raw, priv_len);
    int e2 = mbedtls_base64_encode((unsigned char *)pub_b64_out, out_len, &pub_b64_len, pub_raw, pub_len);
    if (e1 != 0 || e2 != 0) {
        ESP_LOGE(TAG, "Key base64 encode failed: priv=%d pub=%d", e1, e2);
        mbedtls_platform_zeroize(priv_raw, sizeof(priv_raw));
        mbedtls_platform_zeroize(priv_b64, sizeof(priv_b64));
        return ESP_FAIL;
    }
    priv_b64[priv_b64_len] = '\0';
    pub_b64_out[pub_b64_len] = '\0';

    nvs_manager_store_keypair(priv_b64, pub_b64_out);

    /* Scrub the plaintext private key from stack once persisted. */
    mbedtls_platform_zeroize(priv_raw, sizeof(priv_raw));
    mbedtls_platform_zeroize(priv_b64, sizeof(priv_b64));

    ESP_LOGI(TAG, "X25519 keypair generated and stored");
    return ESP_OK;
}

char *secure_channel_decrypt_token(const char *ciphertext_b64, const char *nonce_b64,
                                   const char *server_pub_b64)
{
    char priv_b64[NVS_MAX_KEY_LEN];
    if (nvs_manager_get_private_key(priv_b64, sizeof(priv_b64)) != ESP_OK) {
        ESP_LOGE(TAG, "No private key in NVS");
        return NULL;
    }

    /* Decode + strictly validate every server-influenced field. mbedtls sets
     * *olen to the *required* size on BUFFER_TOO_SMALL, so the return value MUST
     * be checked before any decoded length is trusted — otherwise an oversized
     * field would drive out-of-bounds reads and huge allocations downstream. */
    uint8_t priv_raw[32], server_pub[32], nonce[12];
    uint8_t ct_buf[256];
    size_t priv_len = 0, spub_len = 0, nonce_len = 0, ct_len = 0;

    if (mbedtls_base64_decode(priv_raw, sizeof(priv_raw), &priv_len,
                              (const unsigned char *)priv_b64, strlen(priv_b64)) != 0 ||
        mbedtls_base64_decode(server_pub, sizeof(server_pub), &spub_len,
                              (const unsigned char *)server_pub_b64, strlen(server_pub_b64)) != 0 ||
        mbedtls_base64_decode(nonce, sizeof(nonce), &nonce_len,
                              (const unsigned char *)nonce_b64, strlen(nonce_b64)) != 0 ||
        mbedtls_base64_decode(ct_buf, sizeof(ct_buf), &ct_len,
                              (const unsigned char *)ciphertext_b64, strlen(ciphertext_b64)) != 0) {
        ESP_LOGE(TAG, "Malformed base64 in token payload");
        return NULL;
    }

    if (priv_len != 32 || spub_len != 32 || nonce_len != 12 ||
        ct_len < 16 || ct_len > sizeof(ct_buf)) {
        ESP_LOGE(TAG, "Rejected token: bad field lengths "
                 "(priv=%u spub=%u nonce=%u ct=%u)",
                 (unsigned)priv_len, (unsigned)spub_len,
                 (unsigned)nonce_len, (unsigned)ct_len);
        mbedtls_platform_zeroize(priv_raw, sizeof(priv_raw));
        return NULL;
    }

    /* ECDH via PSA: import our private key, compute shared secret */
    psa_crypto_init();

    psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_DERIVE);
    psa_set_key_algorithm(&attr, PSA_ALG_ECDH);
    psa_set_key_type(&attr, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_MONTGOMERY));
    psa_set_key_bits(&attr, 255);

    psa_key_id_t key_id;
    if (psa_import_key(&attr, priv_raw, priv_len, &key_id) != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Failed to import private key");
        mbedtls_platform_zeroize(priv_raw, sizeof(priv_raw));
        return NULL;
    }
    mbedtls_platform_zeroize(priv_raw, sizeof(priv_raw));

    uint8_t shared_raw[32];
    size_t shared_len;
    psa_status_t status = psa_raw_key_agreement(PSA_ALG_ECDH, key_id,
                                                 server_pub, spub_len,
                                                 shared_raw, sizeof(shared_raw), &shared_len);
    psa_destroy_key(key_id);

    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "ECDH failed: %d", (int)status);
        return NULL;
    }

    /* HKDF-SHA256 via PSA: derive AES key from shared secret */
    uint8_t aes_key[32];
    {
        psa_key_attributes_t ikm_attr = PSA_KEY_ATTRIBUTES_INIT;
        psa_set_key_usage_flags(&ikm_attr, PSA_KEY_USAGE_DERIVE);
        psa_set_key_algorithm(&ikm_attr, PSA_ALG_HKDF(PSA_ALG_SHA_256));
        psa_set_key_type(&ikm_attr, PSA_KEY_TYPE_DERIVE);

        psa_key_id_t ikm_key;
        psa_status_t kd = psa_import_key(&ikm_attr, shared_raw, shared_len, &ikm_key);
        mbedtls_platform_zeroize(shared_raw, sizeof(shared_raw));
        if (kd != PSA_SUCCESS) {
            ESP_LOGE(TAG, "HKDF IKM import failed: %d", (int)kd);
            return NULL;
        }

        psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
        kd  = psa_key_derivation_setup(&op, PSA_ALG_HKDF(PSA_ALG_SHA_256));
        kd |= psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, NULL, 0);
        kd |= psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_SECRET, ikm_key);
        kd |= psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO,
                                       (const uint8_t *)"vellum-token-v1", 15);
        kd |= psa_key_derivation_output_bytes(&op, aes_key, 32);
        psa_key_derivation_abort(&op);
        psa_destroy_key(ikm_key);
        if (kd != PSA_SUCCESS) {
            ESP_LOGE(TAG, "HKDF derivation failed: %d", (int)kd);
            mbedtls_platform_zeroize(aes_key, sizeof(aes_key));
            return NULL;
        }
    }

    /* AES-256-GCM decrypt via PSA */
    size_t plaintext_len = ct_len - 16; /* last 16 bytes = auth tag */
    uint8_t *plaintext = malloc(plaintext_len + 1);
    if (!plaintext) return NULL;

    {
        psa_key_attributes_t aes_attr = PSA_KEY_ATTRIBUTES_INIT;
        psa_set_key_usage_flags(&aes_attr, PSA_KEY_USAGE_DECRYPT);
        psa_set_key_algorithm(&aes_attr, PSA_ALG_GCM);
        psa_set_key_type(&aes_attr, PSA_KEY_TYPE_AES);
        psa_set_key_bits(&aes_attr, 256);

        psa_key_id_t aes_key_id;
        psa_status_t imp = psa_import_key(&aes_attr, aes_key, 32, &aes_key_id);
        mbedtls_platform_zeroize(aes_key, sizeof(aes_key));
        if (imp != PSA_SUCCESS) {
            ESP_LOGE(TAG, "AES key import failed: %d", (int)imp);
            free(plaintext);
            return NULL;
        }

        size_t out_len;
        /* GCM ciphertext format: ciphertext || tag (16 bytes) */
        /* PSA expects: nonce || ciphertext || tag as input to aead_decrypt */
        /* Build nonce-prefixed buffer for PSA */
        size_t aead_input_len = nonce_len + ct_len;
        uint8_t *aead_input = malloc(aead_input_len);
        if (!aead_input) { free(plaintext); psa_destroy_key(aes_key_id); return NULL; }
        memcpy(aead_input, nonce, nonce_len);
        memcpy(aead_input + nonce_len, ct_buf, ct_len);

        psa_status_t dec_status = psa_aead_decrypt(aes_key_id, PSA_ALG_GCM,
                                                    aead_input, nonce_len,  /* nonce */
                                                    NULL, 0,                /* aad */
                                                    ct_buf, ct_len,         /* ciphertext + tag */
                                                    plaintext, plaintext_len, &out_len);
        free(aead_input);
        psa_destroy_key(aes_key_id);

        if (dec_status != PSA_SUCCESS) {
            ESP_LOGE(TAG, "AES-GCM decrypt failed: %d", (int)dec_status);
            free(plaintext);
            return NULL;
        }
        plaintext_len = out_len;
    }

    plaintext[plaintext_len] = '\0';
    return (char *)plaintext;
}
