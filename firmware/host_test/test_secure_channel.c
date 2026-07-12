// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file test_secure_channel.c
 * @brief KAT for the device token-decryption contract.
 *
 * Mirrors secure_channel_decrypt_token() in secure_channel.c: X25519 ECDH →
 * HKDF-SHA256 (empty salt, info "vellum-token-v1", 32-byte key) → AES-256-GCM
 * decrypt of a `ciphertext || tag(16)` payload with a 12-byte nonce. The device
 * uses PSA; this host test uses OpenSSL, which implements the same primitives.
 * The vector is produced by scripts/gen_kat.mjs using the SERVER-side encrypt
 * path, so it pins the full cross-stack construction (curve, KDF label, AEAD
 * layout) — any drift on either side breaks this test.
 */
#include "unity_min.h"
#include "kat_util.h"

#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/core_names.h>
#include <openssl/params.h>
#include <string.h>

/* Golden vector (see scratchpad/gen_kat.mjs → SECURE_CHANNEL_KAT). */
static const char *DEVICE_PRIV_B64 = "ERERERERERERERERERERERERERERERERERERERERERE=";
static const char *SERVER_PUB_B64 = "D6poTtKIZ7l/Smot7l34zpdOdrcBjj8iocTPJnhXDyA=";
static const char *NONCE_B64 = "ASNFZ4mrASNFZ4mr";
static const char *CIPHERTEXT_B64 = "cvNB658ixI55bhE42V8o37xLc3ZYxsJ7CJH3lhMKUYxhpyE=";
static const char *EXPECTED_PLAINTEXT = "device-token-abc123";

/* Mirror of secure_channel_decrypt_token(). Returns plaintext length, or -1 on
 * any failure (bad lengths / ECDH / KDF / AEAD auth). NUL-terminates `out`. */
static int decrypt_token(const uint8_t *dpriv, const uint8_t *spub,
                         const uint8_t *nonce, size_t nonce_len,
                         const uint8_t *ct_tag, size_t ct_tag_len, char *out,
                         size_t out_cap)
{
    if (nonce_len != 12 || ct_tag_len < 16) return -1;

    /* --- X25519 ECDH --- */
    uint8_t shared[32];
    size_t shared_len = sizeof(shared);
    EVP_PKEY *priv = EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, NULL, dpriv, 32);
    EVP_PKEY *peer = EVP_PKEY_new_raw_public_key(EVP_PKEY_X25519, NULL, spub, 32);
    int ok = priv && peer;
    if (ok) {
        EVP_PKEY_CTX *dctx = EVP_PKEY_CTX_new(priv, NULL);
        ok = dctx && EVP_PKEY_derive_init(dctx) == 1 &&
             EVP_PKEY_derive_set_peer(dctx, peer) == 1 &&
             EVP_PKEY_derive(dctx, shared, &shared_len) == 1 && shared_len == 32;
        EVP_PKEY_CTX_free(dctx);
    }
    EVP_PKEY_free(priv);
    EVP_PKEY_free(peer);
    if (!ok) return -1;

    /* --- HKDF-SHA256: empty salt, info "vellum-token-v1", 32-byte AES key ---
     * Uses the OpenSSL 3.x EVP_KDF API (default HKDF mode = extract-and-expand,
     * i.e. full RFC 5869 HKDF), matching the device's PSA_ALG_HKDF(SHA_256). */
    uint8_t aes_key[32];
    EVP_KDF *kdf = EVP_KDF_fetch(NULL, "HKDF", NULL);
    EVP_KDF_CTX *kctx = kdf ? EVP_KDF_CTX_new(kdf) : NULL;
    OSSL_PARAM params[] = {
        OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, (char *)"SHA256", 0),
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY, shared, 32),
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, (void *)"", 0),
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO, (void *)"vellum-token-v1", 15),
        OSSL_PARAM_construct_end(),
    };
    ok = kctx && EVP_KDF_derive(kctx, aes_key, sizeof(aes_key), params) == 1;
    EVP_KDF_CTX_free(kctx);
    EVP_KDF_free(kdf);
    if (!ok) return -1;

    /* --- AES-256-GCM decrypt: ct_tag = ciphertext || tag(16) --- */
    size_t ct_len = ct_tag_len - 16;
    const uint8_t *tag = ct_tag + ct_len;
    if (ct_len + 1 > out_cap) return -1;

    EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
    int rc = -1, outl = 0, finl = 0;
    if (c && EVP_DecryptInit_ex(c, EVP_aes_256_gcm(), NULL, NULL, NULL) == 1 &&
        EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) == 1 &&
        EVP_DecryptInit_ex(c, NULL, NULL, aes_key, nonce) == 1 &&
        EVP_DecryptUpdate(c, (uint8_t *)out, &outl, ct_tag, (int)ct_len) == 1 &&
        EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_TAG, 16, (void *)tag) == 1 &&
        EVP_DecryptFinal_ex(c, (uint8_t *)out + outl, &finl) == 1) {
        out[outl + finl] = '\0';
        rc = outl + finl;
    }
    EVP_CIPHER_CTX_free(c);
    return rc;
}

void test_decrypt_valid_token(void)
{
    uint8_t dpriv[32], spub[32], nonce[12], ct[64];
    TEST_ASSERT_EQUAL_INT(32, b64_decode(DEVICE_PRIV_B64, dpriv, sizeof(dpriv)));
    TEST_ASSERT_EQUAL_INT(32, b64_decode(SERVER_PUB_B64, spub, sizeof(spub)));
    TEST_ASSERT_EQUAL_INT(12, b64_decode(NONCE_B64, nonce, sizeof(nonce)));
    int ctlen = b64_decode(CIPHERTEXT_B64, ct, sizeof(ct));
    TEST_ASSERT_TRUE(ctlen > 16);

    char out[128];
    int n = decrypt_token(dpriv, spub, nonce, 12, ct, (size_t)ctlen, out, sizeof(out));
    TEST_ASSERT_EQUAL_INT((int)strlen(EXPECTED_PLAINTEXT), n);
    TEST_ASSERT_EQUAL_STRING(EXPECTED_PLAINTEXT, out);
}

void test_decrypt_tampered_ciphertext_rejected(void)
{
    uint8_t dpriv[32], spub[32], nonce[12], ct[64];
    b64_decode(DEVICE_PRIV_B64, dpriv, sizeof(dpriv));
    b64_decode(SERVER_PUB_B64, spub, sizeof(spub));
    b64_decode(NONCE_B64, nonce, sizeof(nonce));
    int ctlen = b64_decode(CIPHERTEXT_B64, ct, sizeof(ct));
    ct[0] ^= 0x01; /* corrupt first ciphertext byte → GCM tag must fail */

    char out[128];
    TEST_ASSERT_EQUAL_INT(-1, decrypt_token(dpriv, spub, nonce, 12, ct,
                                            (size_t)ctlen, out, sizeof(out)));
}

void test_decrypt_wrong_nonce_rejected(void)
{
    uint8_t dpriv[32], spub[32], nonce[12], ct[64];
    b64_decode(DEVICE_PRIV_B64, dpriv, sizeof(dpriv));
    b64_decode(SERVER_PUB_B64, spub, sizeof(spub));
    b64_decode(NONCE_B64, nonce, sizeof(nonce));
    int ctlen = b64_decode(CIPHERTEXT_B64, ct, sizeof(ct));
    nonce[0] ^= 0x01; /* wrong IV → auth failure */

    char out[128];
    TEST_ASSERT_EQUAL_INT(-1, decrypt_token(dpriv, spub, nonce, 12, ct,
                                            (size_t)ctlen, out, sizeof(out)));
}

void test_decrypt_wrong_server_key_rejected(void)
{
    uint8_t dpriv[32], spub[32], nonce[12], ct[64];
    b64_decode(DEVICE_PRIV_B64, dpriv, sizeof(dpriv));
    b64_decode(SERVER_PUB_B64, spub, sizeof(spub));
    b64_decode(NONCE_B64, nonce, sizeof(nonce));
    int ctlen = b64_decode(CIPHERTEXT_B64, ct, sizeof(ct));
    spub[0] ^= 0x01; /* different ECDH peer → different AES key → auth failure */

    char out[128];
    TEST_ASSERT_EQUAL_INT(-1, decrypt_token(dpriv, spub, nonce, 12, ct,
                                            (size_t)ctlen, out, sizeof(out)));
}

void run_secure_channel_tests(void)
{
    RUN_TEST(test_decrypt_valid_token);
    RUN_TEST(test_decrypt_tampered_ciphertext_rejected);
    RUN_TEST(test_decrypt_wrong_nonce_rejected);
    RUN_TEST(test_decrypt_wrong_server_key_rejected);
}
