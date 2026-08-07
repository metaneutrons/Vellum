// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file ota_manager.c
 * @brief OTA update flow: /config → download → verify → apply.
 *
 * Trust chain (all BEFORE the image is made bootable):
 *   1. Download into the inactive OTA slot via esp_https_ota_begin/perform.
 *   2. SHA-256 the staged partition; require it to equal the server's otaSha256.
 *   3. Ed25519-verify the server's signature over that 32-byte digest
 *      (PSA_ALG_PURE_EDDSA). Fail-closed: in production a missing/invalid
 *      signature aborts the update.
 *   4. Only then esp_https_ota_finish() sets the boot partition.
 *
 * With bootloader rollback enabled, the new image boots PENDING_VERIFY and is
 * confirmed by ota_manager_mark_valid() after a good server round-trip; an
 * image that fails to do so is rolled back by the bootloader on next boot.
 *
 * The signing contract: the server signs the raw 32-byte SHA-256 digest of the
 * firmware image with Ed25519; otaSignature is base64 of the 64-byte sig. The
 * device verifies it against a compile-time trust store (ota_trust_keys.h) — a
 * primary key plus an optional reserved "next" key — accepting the signature if
 * it validates under ANY non-revoked trusted key. That keyring is what makes
 * signing-key rotation possible without a hard, fleet-wide cutover.
 */

#include "ota_manager.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "cJSON.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"
#include "esp_crt_bundle.h"
#include "mbedtls/base64.h"
#include "sodium/crypto_sign.h"

#include "http_client.h"
#include "vellum_display.h"
#include "board.h"
#include "esp_attr.h"
#include "esp_rom_crc.h"
#include "sdkconfig.h"
#include "ota_trust_keys.h"

static const char *TAG = "ota";

#if defined(CONFIG_VELLUM_OTA_REQUIRE_SIGNATURE)
  #define OTA_REQUIRE_SIGNATURE 1
#else
  #define OTA_REQUIRE_SIGNATURE 0
#endif

/** True if `id` appears as a whole comma-separated token in `csv`
 *  (surrounding spaces tolerated). Used for the revoked-key-id check. */
static bool csv_contains_token(const char *csv, const char *id)
{
    if (!csv || !*csv || !id || !*id) return false;
    const size_t idlen = strlen(id);
    const char *p = csv;
    while (*p) {
        while (*p == ',' || *p == ' ') p++;      /* skip separators + leading space */
        const char *start = p;
        while (*p && *p != ',') p++;             /* to next comma / end */
        size_t len = (size_t)(p - start);
        while (len > 0 && start[len - 1] == ' ') len--;  /* trim trailing space */
        if (len == idlen && strncmp(start, id, idlen) == 0) return true;
    }
    return false;
}

/** True if a trusted key's id has been revoked (CONFIG_VELLUM_OTA_REVOKED_KEY_IDS). */
static bool key_is_revoked(const char *key_id)
{
    return csv_contains_token(CONFIG_VELLUM_OTA_REVOKED_KEY_IDS, key_id);
}

/**
 * Verify the 64-byte Ed25519 `sig` over `digest` under ONE base64 public key.
 * @return true on a valid Ed25519 signature; false on decode/verify failure.
 *         Isolated so the trust store can try each key in turn.
 */
static bool verify_one_key(const char *pubkey_b64, const uint8_t digest[32],
                           const uint8_t *sig, size_t sig_len)
{
    uint8_t pubkey[32];
    size_t pubkey_len = 0;
    if (mbedtls_base64_decode(pubkey, sizeof(pubkey), &pubkey_len,
                              (const unsigned char *)pubkey_b64, strlen(pubkey_b64)) != 0 ||
        pubkey_len != 32) {
        ESP_LOGE(TAG, "Bad OTA public key (need raw 32-byte Ed25519, base64)");
        return false;
    }

    if (sig_len != crypto_sign_BYTES) {
        ESP_LOGE(TAG, "Bad OTA signature length: %u", (unsigned)sig_len);
        return false;
    }

    return crypto_sign_verify_detached(sig, digest, 32, pubkey) == 0;
}

/**
 * Verify an Ed25519 signature over the 32-byte SHA-256 digest of the image
 * against the on-device trust store (ota_trust_keys.h). Accepts the signature
 * if it validates under ANY non-revoked trusted key.
 * @param digest       32-byte SHA-256 of the staged firmware.
 * @param sig_b64      base64 of the 64-byte Ed25519 signature.
 * @param key_id_hint  optional key id from /config (otaKeyId). Only a fast-path
 *                     hint — NEVER authoritative; a wrong/absent hint just costs
 *                     a fallback over the full store, so a crafted /config can't
 *                     force-select or skip keys.
 * @return true if a valid signature was verified; false otherwise.
 *         When the store holds no usable key this fails CLOSED unless
 *         CONFIG_VELLUM_OTA_ALLOW_UNSIGNED is set for local development.
 */
static bool verify_ota_signature(const uint8_t digest[32], const char *sig_b64,
                                 const char *key_id_hint)
{
    /* Is any key actually usable (non-empty pubkey, not revoked)? */
    bool have_key = false;
    for (size_t i = 0; i < s_trusted_keys_len; i++) {
        if (s_trusted_keys[i].pubkey_b64 && s_trusted_keys[i].pubkey_b64[0] &&
            !key_is_revoked(s_trusted_keys[i].key_id)) {
            have_key = true;
            break;
        }
    }
    if (!have_key) {
#if defined(CONFIG_VELLUM_OTA_ALLOW_UNSIGNED)
        /* Two flags must BOTH be set to accept unsigned firmware: ALLOW_UNSIGNED
         * (this #if) AND !REQUIRE_SIGNATURE. So REQUIRE_SIGNATURE=y (the default)
         * stays fail-closed even if someone also enabled ALLOW_UNSIGNED. */
        if (OTA_REQUIRE_SIGNATURE) {
            ESP_LOGE(TAG, "No OTA signing key, but signatures are REQUIRED "
                          "(CONFIG_VELLUM_OTA_REQUIRE_SIGNATURE) — refusing (fail-closed). "
                          "To accept unsigned on the bench, also set REQUIRE_SIGNATURE=n.");
            return false;
        }
        /* Dev-only escape hatch. Log loudly so this never passes unnoticed. */
        ESP_LOGW(TAG, "!!! No OTA signing key configured — ACCEPTING UNSIGNED "
                      "firmware (CONFIG_VELLUM_OTA_ALLOW_UNSIGNED + REQUIRE_SIGNATURE=n). "
                      "This must NEVER be enabled in production.");
        return true;
#else
        ESP_LOGE(TAG, "No OTA signing key configured — refusing OTA (fail-closed)");
        return false;
#endif
    }
    if (!sig_b64 || strlen(sig_b64) == 0) {
        ESP_LOGE(TAG, "OTA signature missing");
        return false;
    }

    uint8_t sig[64];
    size_t sig_len = 0;
    if (mbedtls_base64_decode(sig, sizeof(sig), &sig_len,
                              (const unsigned char *)sig_b64, strlen(sig_b64)) != 0 ||
        sig_len != 64) {
        ESP_LOGE(TAG, "Bad OTA signature length");
        return false;
    }

    if (psa_crypto_init() != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_crypto_init failed");
        return false;
    }

    /* Fast path: try the hinted key first (never authoritative). */
    if (key_id_hint && *key_id_hint) {
        for (size_t i = 0; i < s_trusted_keys_len; i++) {
            const ota_trusted_key_t *k = &s_trusted_keys[i];
            if (!k->pubkey_b64 || !k->pubkey_b64[0]) continue;
            if (key_is_revoked(k->key_id)) continue;
            if (strcmp(k->key_id, key_id_hint) != 0) continue;
            if (verify_one_key(k->pubkey_b64, digest, sig, sig_len)) {
                ESP_LOGI(TAG, "OTA signature verified ✓ (key %s)", k->key_id);
                return true;
            }
            break;  /* hinted key present but didn't verify — fall through to full scan */
        }
    }

    /* Fallback: try every non-revoked, non-empty trusted key. */
    for (size_t i = 0; i < s_trusted_keys_len; i++) {
        const ota_trusted_key_t *k = &s_trusted_keys[i];
        if (!k->pubkey_b64 || !k->pubkey_b64[0]) continue;   /* inert reserved slot */
        if (key_is_revoked(k->key_id)) continue;
        if (verify_one_key(k->pubkey_b64, digest, sig, sig_len)) {
            ESP_LOGI(TAG, "OTA signature verified ✓ (key %s)", k->key_id);
            return true;
        }
    }

    ESP_LOGE(TAG, "OTA signature verified by NO trusted key");
    return false;
}

/** True if the offered version differs from the running one (avoid reflash loop). */
static bool version_is_new(const char *offered)
{
    if (!offered || strlen(offered) == 0) return false;
    const esp_app_desc_t *app = esp_app_get_description();
    if (app && strncmp(app->version, offered, sizeof(app->version)) == 0) {
        ESP_LOGI(TAG, "OTA offered version %s == running — skipping", offered);
        return false;
    }
    return true;
}

/* Parse leading major.minor.patch from a version string (ignores -pre/+build). */
static void ota_parse_mmp(const char *v, int out[3])
{
    out[0] = out[1] = out[2] = 0;
    if (!v) return;
    if (*v == 'v') v++;
    sscanf(v, "%d.%d.%d", &out[0], &out[1], &out[2]);
}

/* True if `offered` is a strictly-older RELEASE than the running one (compares
 * major.minor.patch only — a pre-release-only difference is not treated as a
 * downgrade). Defense-in-depth against a replayed/tampered older signed image. */
static bool ota_is_downgrade(const char *offered)
{
    const esp_app_desc_t *app = esp_app_get_description();
    if (!app || !offered) return false;
    int o[3], r[3];
    ota_parse_mmp(offered, o);
    ota_parse_mmp(app->version, r);
    for (int i = 0; i < 3; i++) if (o[i] != r[i]) return o[i] < r[i];
    return false;
}

/* Fire-and-forget OTA outcome report to the server. `to` is the target version. */
static esp_err_t ota_report(const char *to, const char *phase, const char *err)
{
    const esp_app_desc_t *app = esp_app_get_description();
    return http_client_ota_report(CONFIG_VELLUM_DISPLAY_MODEL,
                                  app ? app->version : NULL, to, phase, err);
}

/* If the bootloader rolled a failed image back to us, report the FAILED version
 * so the server blocklists it — otherwise we'd re-report our old version and be
 * re-served the exact same bad image forever (the brick-retry loop). RTC memory
 * dedups across deep-sleep wakes; a magic guard resets it on a cold boot
 * (RTC_NOINIT is uninitialised at power-on). Reported once per rollback. */
#define OTA_RB_MAGIC 0x56454C55u  /* "VELU" */
RTC_NOINIT_ATTR static uint32_t s_rb_magic;
RTC_NOINIT_ATTR static uint32_t s_rb_reported_crc;

static void ota_report_rollback_if_needed(void)
{
    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    if (!bad) return;
    esp_app_desc_t bad_desc;
    if (esp_ota_get_partition_description(bad, &bad_desc) != ESP_OK) return;

    if (s_rb_magic != OTA_RB_MAGIC) { s_rb_magic = OTA_RB_MAGIC; s_rb_reported_crc = 0; }
    uint32_t crc = esp_rom_crc32_le(0, (const uint8_t *)bad_desc.version,
                                    strlen(bad_desc.version));
    if (crc == s_rb_reported_crc) return;  /* already reported this rollback */

    ESP_LOGW(TAG, "Detected rolled-back image %s — reporting for blocklist", bad_desc.version);
    if (ota_report(bad_desc.version, "rolled_back", "boot_health_check") == ESP_OK) {
        s_rb_reported_crc = crc;
    }
}

void ota_manager_check_and_apply(void)
{
    /* Power guard (anti-brick): an OTA is a large flash write followed by a
     * reboot; a brownout mid-write can corrupt the staged slot. Require USB
     * power, or a battery with enough headroom, before doing ANY network work. */
    if (!board_is_usb_powered()) {
        int battery = board_battery_level();
        if (battery < CONFIG_VELLUM_OTA_MIN_BATTERY_PCT) {
            ESP_LOGW(TAG, "Skipping OTA: battery %d%% < %d%% and not USB-powered",
                     battery, CONFIG_VELLUM_OTA_MIN_BATTERY_PCT);
            return;
        }
    }

    ESP_LOGI(TAG, "Checking for OTA update via /config");
    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_config(&resp);

    if (err != ESP_OK || resp.status_code != 200 || !resp.body) {
        http_client_free_response(&resp);
        return;
    }

    cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
    if (!root) { http_client_free_response(&resp); return; }

    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    cJSON *ota_url = data ? cJSON_GetObjectItemCaseSensitive(data, "otaUrl") : NULL;
    cJSON *ota_ver = data ? cJSON_GetObjectItemCaseSensitive(data, "otaVersion") : NULL;
    cJSON *ota_sha = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSha256") : NULL;
    cJSON *ota_sig = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSignature") : NULL;
    cJSON *ota_kid = data ? cJSON_GetObjectItemCaseSensitive(data, "otaKeyId") : NULL;
    cJSON *ota_dg  = data ? cJSON_GetObjectItemCaseSensitive(data, "allowDowngrade") : NULL;
    bool allow_downgrade = cJSON_IsBool(ota_dg) && cJSON_IsTrue(ota_dg);

    if (!cJSON_IsString(ota_url) || !ota_url->valuestring || strlen(ota_url->valuestring) == 0) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Enterprise transport policy: firmware images are fetched over validated
     * TLS only. The Ed25519 signature is still the integrity backstop, but https
     * prevents passive disclosure and redirect-based downgrade of the download. */
    if (strncmp(ota_url->valuestring, "https://", 8) != 0) {
        ESP_LOGE(TAG, "Refusing OTA over insecure URL (https:// required): %s",
                 ota_url->valuestring);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Version gate: don't re-flash the version we're already running. */
    if (cJSON_IsString(ota_ver) && !version_is_new(ota_ver->valuestring)) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Downgrade guard (defense-in-depth): refuse a strictly-older image unless the
     * server sanctioned it (an operator pin-downgrade sets allowDowngrade). The
     * server's auto path never offers older, so an unsanctioned downgrade offer
     * means replay/tamper — don't flash it, and don't blocklist it (it's not bad). */
    if (cJSON_IsString(ota_ver) && ota_is_downgrade(ota_ver->valuestring) && !allow_downgrade) {
        ESP_LOGW(TAG, "Refusing unsanctioned downgrade to %s (running newer)",
                 ota_ver->valuestring);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    ESP_LOGI(TAG, "OTA update: %s → %s",
             cJSON_IsString(ota_ver) ? ota_ver->valuestring : "?", ota_url->valuestring);
    /* Stable copy of the target version — the cJSON it lives in is freed before
     * the "applied" report point. */
    char to_ver[64];
    snprintf(to_ver, sizeof(to_ver), "%s",
             cJSON_IsString(ota_ver) && ota_ver->valuestring ? ota_ver->valuestring : "");

    display_show_ota_progress(0);
    board_buzzer_beep(800, 200);

    esp_http_client_config_t http_cfg = {
        .url = ota_url->valuestring,
        .timeout_ms = 120000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        /* Larger buffers for delivery robustness: GitHub Releases redirects
         * carry long Location headers (rx), and weak links benefit from a bigger
         * receive window than the 512-byte default. */
        .buffer_size = 4096,
        .buffer_size_tx = 1024,
    };
    esp_https_ota_config_t ota_cfg = { .http_config = &http_cfg };

    esp_https_ota_handle_t handle = NULL;
    if (esp_https_ota_begin(&ota_cfg, &handle) != ESP_OK || handle == NULL) {
        ESP_LOGW(TAG, "esp_https_ota_begin failed");
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* ── Anti-brick: reject a wrong-model image BEFORE downloading it ────
     * All four models (e1001/e1002/e1003/d1001) are signed with the same key,
     * so the Ed25519 signature can't tell them apart — a mis-targeted image
     * would verify and then brick the device. The app descriptor project_name
     * is baked per-model as "vellum-<model>" (see CMakeLists.txt); compare the
     * staged image's project_name against the running one and abort on any
     * mismatch. esp_https_ota_begin() has already fetched the image header, so
     * the descriptor is available here. */
    esp_app_desc_t staged_desc;
    if (esp_https_ota_get_img_desc(handle, &staged_desc) != ESP_OK) {
        ESP_LOGE(TAG, "Cannot read staged image descriptor — aborting OTA");
        esp_https_ota_abort(handle);
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }
    const esp_app_desc_t *running_desc = esp_app_get_description();
    if (!running_desc ||
        strncmp(staged_desc.project_name, running_desc->project_name,
                sizeof(staged_desc.project_name)) != 0) {
        ESP_LOGE(TAG, "OTA model mismatch: staged '%s' != running '%s' — aborting",
                 staged_desc.project_name,
                 running_desc ? running_desc->project_name : "?");
        ota_report(to_ver, "verify_fail", "model_mismatch");
        esp_https_ota_abort(handle);
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Download the image into the inactive slot (not yet bootable).  IDF's
     * perform call returns after each received chunk, which lets us expose
     * honest byte progress instead of leaving the display at the initial 0%. */
    uint8_t displayed_percent = 0;
    do {
        err = esp_https_ota_perform(handle);
        int64_t total = esp_https_ota_get_image_size(handle);
        int64_t received = esp_https_ota_get_image_len_read(handle);
        if (total > 0 && received >= 0) {
            int calculated = (int)((received * 100) / total);
            if (calculated > 99) calculated = 99; /* 100 means verified/applied */
            uint8_t percent = (uint8_t)calculated;
            if (percent >= displayed_percent + 10) {
                displayed_percent = percent;
                display_show_ota_progress(percent);
            }
        }
    } while (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS);

    bool ok = (err == ESP_OK) && esp_https_ota_is_complete_data_received(handle);
    if (!ok) {
        ESP_LOGW(TAG, "OTA download incomplete: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* ── Verify the staged image BEFORE making it bootable ──────── */
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *update = esp_ota_get_next_update_partition(running);
    bool verified = false;

    if (update) {
        uint8_t sha[32];
        if (esp_partition_get_sha256(update, sha) == ESP_OK) {
            char sha_hex[65];
            for (int i = 0; i < 32; i++) sprintf(sha_hex + i * 2, "%02x", sha[i]);
            sha_hex[64] = '\0';

            /* The expected digest is mandatory: without a server-supplied
             * otaSha256 the device has nothing to pin the image to, so treat a
             * missing digest as a failure rather than silently trusting it. */
            if (!cJSON_IsString(ota_sha) || !ota_sha->valuestring) {
                ESP_LOGE(TAG, "Server did not supply otaSha256 — refusing OTA");
            } else if (strcmp(sha_hex, ota_sha->valuestring) != 0) {
                ESP_LOGE(TAG, "SHA256 mismatch: expected %s got %s",
                         ota_sha->valuestring, sha_hex);
            } else {
                ESP_LOGI(TAG, "SHA256 verified ✓");
                verified = verify_ota_signature(
                    sha,
                    cJSON_IsString(ota_sig) ? ota_sig->valuestring : NULL,
                    cJSON_IsString(ota_kid) ? ota_kid->valuestring : NULL);
            }
        } else {
            ESP_LOGE(TAG, "esp_partition_get_sha256 failed");
        }
    }

    if (!verified) {
        ESP_LOGE(TAG, "OTA verification failed — aborting (image not booted)");
        ota_report(to_ver, "verify_fail", "verify");
        esp_https_ota_abort(handle);
        display_show_error("Firmware update failed\nWill retry later");
        board_buzzer_beep(500, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Verified — finish() sets the boot partition (PENDING_VERIFY w/ rollback). */
    esp_err_t fin = esp_https_ota_finish(handle);
    cJSON_Delete(root);
    http_client_free_response(&resp);

    if (fin != ESP_OK) {
        ESP_LOGE(TAG, "esp_https_ota_finish failed: %s", esp_err_to_name(fin));
        display_show_error("Firmware update failed\nWill retry later");
        board_buzzer_beep(500, 500);
        return;
    }

    ESP_LOGI(TAG, "OTA verified + applied — restarting");
    display_show_ota_progress(100);
    ota_report(to_ver, "applied", NULL);
    board_buzzer_beep(2000, 100); vTaskDelay(pdMS_TO_TICKS(100)); board_buzzer_beep(2000, 100);
    esp_restart();
}

void ota_manager_mark_valid(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "First boot of new image confirmed good — cancelling rollback");
        esp_ota_mark_app_valid_cancel_rollback();
        const esp_app_desc_t *app = esp_app_get_description();
        http_client_ota_report(CONFIG_VELLUM_DISPLAY_MODEL, NULL,
                               app ? app->version : NULL, "boot_confirmed", NULL);
    }

    /* Detect + report a bootloader rollback so the server blocklists the bad
     * version (breaks the brick-retry loop). Runs on every boot; deduped. */
    ota_report_rollback_if_needed();
}
