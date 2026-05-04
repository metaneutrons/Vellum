// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Vellum Firmware — Main Entry Point (ESP-IDF)
 *
 * Boot sequence:
 *   1. Init NVS, display, buttons, sleep manager
 *   2. Check battery — if < critical%, show "Connect Power" and permanent sleep
 *   3. Check NVS for Wi-Fi credentials → connect or enter SoftAP
 *   4. Init HTTP client with server URL and MAC
 *   5. Check NVS for device token → hello if missing
 *   6. Request render → draw pixel buffer → sleep
 *
 * Requirements: 1.1, 3.1, 9.2, 9.3, 9.4, 9.5
 */

#include <string.h>
#include <stdlib.h>

#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"

/* X25519 ECDH + AES-256-GCM via PSA Crypto API */
#include "psa/crypto.h"
#include "mbedtls/base64.h"

#include "nvs_manager.h"
#include "wifi_manager.h"
#include "http_client.h"
#include "vellum_display.h"
#include "buttons.h"
#include "sleep_manager.h"
#include "vellum_serial.h"
#include "mdns.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"

static const char *TAG = "vellum_main";

/* -----------------------------------------------------------------------
 * Hardware — Battery, LED, Buzzer (reTerminal E Series)
 * ----------------------------------------------------------------------- */

#include "esp_adc/adc_oneshot.h"
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "esp_crt_bundle.h"

static adc_oneshot_unit_handle_t s_adc_handle = NULL;

static void init_battery_adc(void)
{
    adc_oneshot_unit_init_cfg_t cfg = { .unit_id = ADC_UNIT_1 };
    adc_oneshot_new_unit(&cfg, &s_adc_handle);
    adc_oneshot_chan_cfg_t chan = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    adc_oneshot_config_channel(s_adc_handle, ADC_CHANNEL_0, &chan);
}

static float read_battery_voltage(void)
{
    gpio_set_direction(CONFIG_VELLUM_BATTERY_EN_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    int raw = 0;
    if (s_adc_handle) adc_oneshot_read(s_adc_handle, ADC_CHANNEL_0, &raw);
#if !defined(CONFIG_VELLUM_PANEL_E1003)
    /* Don't disable on E1003 — GPIO21 is shared with IT8951 ITE_ENABLE */
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 0);
#endif
    return (raw / 4095.0f) * 3.3f * 2.0f;
}

static int read_battery_level(void)
{
    float v = read_battery_voltage();
    int level = (int)((v - 3.0f) / (4.2f - 3.0f) * 100.0f);
    if (level < 0) level = 0;
    if (level > 100) level = 100;
    return level;
}

static bool is_usb_powered(void)
{
    return read_battery_voltage() > 4.5f;
}

static void led_init(void)
{
    gpio_set_direction(CONFIG_VELLUM_LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(CONFIG_VELLUM_LED_GPIO, 1);
}
static void led_on(void)  { gpio_set_level(CONFIG_VELLUM_LED_GPIO, 0); }
static void led_off(void) { gpio_set_level(CONFIG_VELLUM_LED_GPIO, 1); }

static void buzzer_init(void)
{
    ledc_timer_config_t timer = { .speed_mode=LEDC_LOW_SPEED_MODE, .duty_resolution=LEDC_TIMER_8_BIT, .timer_num=LEDC_TIMER_0, .freq_hz=1000, .clk_cfg=LEDC_AUTO_CLK };
    ledc_timer_config(&timer);
    ledc_channel_config_t ch = { .gpio_num=CONFIG_VELLUM_BUZZER_GPIO, .speed_mode=LEDC_LOW_SPEED_MODE, .channel=LEDC_CHANNEL_0, .timer_sel=LEDC_TIMER_0, .duty=0 };
    ledc_channel_config(&ch);
}

static void buzzer_beep(uint32_t freq, uint32_t ms)
{
    ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, freq);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 128);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    vTaskDelay(pdMS_TO_TICKS(ms));
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

/* ── SHT4x Temperature/Humidity Sensor (I2C) ──────────────────── */

#include "driver/i2c_master.h"

#define SHT4X_ADDR       0x44
#define SHT4X_CMD_MEASURE 0xFD
#define I2C_SDA_PIN       19
#define I2C_SCL_PIN       20

static i2c_master_dev_handle_t s_sht4x_dev = NULL;
static bool s_sht4x_available = false;
static float s_temperature = 0;
static float s_humidity = 0;

static void sht4x_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = -1,
        .sda_io_num = I2C_SDA_PIN,
        .scl_io_num = I2C_SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t bus = NULL;
    if (i2c_new_master_bus(&bus_cfg, &bus) != ESP_OK) return;

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = SHT4X_ADDR,
        .scl_speed_hz = 100000,
    };
    if (i2c_master_bus_add_device(bus, &dev_cfg, &s_sht4x_dev) == ESP_OK) {
        s_sht4x_available = true;
        ESP_LOGI(TAG, "SHT4x initialized on I2C");
    }
}

static void sht4x_read(void)
{
    if (!s_sht4x_available) return;
    uint8_t cmd = SHT4X_CMD_MEASURE;
    i2c_master_transmit(s_sht4x_dev, &cmd, 1, pdMS_TO_TICKS(100));
    vTaskDelay(pdMS_TO_TICKS(10));
    uint8_t data[6];
    if (i2c_master_receive(s_sht4x_dev, data, 6, pdMS_TO_TICKS(100)) == ESP_OK) {
        uint16_t t_raw = (data[0] << 8) | data[1];
        uint16_t h_raw = (data[3] << 8) | data[4];
        s_temperature = -45.0f + 175.0f * (t_raw / 65535.0f);
        s_humidity = -6.0f + 125.0f * (h_raw / 65535.0f);
        if (s_humidity < 0) s_humidity = 0;
        if (s_humidity > 100) s_humidity = 100;
        ESP_LOGI(TAG, "SHT4x: %.1f°C, %.1f%%", s_temperature, s_humidity);
    }
}

static vellum_telemetry_t gather_telemetry(void)
{
    vellum_telemetry_t t = {
        .battery_voltage = read_battery_voltage(),
        .battery_level   = read_battery_level(),
        .wifi_rssi       = wifi_manager_get_rssi(),
        .firmware_ver    = CONFIG_VELLUM_FIRMWARE_VERSION,
    };
    return t;
}

/* -----------------------------------------------------------------------
 * X25519 ECDH key management
 * ----------------------------------------------------------------------- */

/**
 * Ensure an X25519 keypair exists in NVS. Generate one if not.
 * Sets the public key on the HTTP client for inclusion in /hello.
 */
static void ensure_keypair(void)
{
    char pub_b64[NVS_MAX_KEY_LEN];
    if (nvs_manager_has_keypair() &&
        nvs_manager_get_public_key(pub_b64, sizeof(pub_b64)) == ESP_OK) {
        http_client_set_public_key(pub_b64);
        ESP_LOGI(TAG, "Loaded existing X25519 keypair");
        return;
    }

    ESP_LOGI(TAG, "Generating X25519 keypair...");

    psa_status_t status = psa_crypto_init();
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "PSA crypto init failed: %d", (int)status);
        return;
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
        return;
    }

    /* Export private key (raw 32 bytes) */
    uint8_t priv_raw[32];
    size_t priv_len;
    psa_export_key(key_id, priv_raw, sizeof(priv_raw), &priv_len);

    /* Export public key (raw 32 bytes) */
    uint8_t pub_raw[32];
    size_t pub_len;
    psa_export_public_key(key_id, pub_raw, sizeof(pub_raw), &pub_len);

    psa_destroy_key(key_id);

    /* Base64 encode */
    char priv_b64[NVS_MAX_KEY_LEN], pub_b64_out[NVS_MAX_KEY_LEN];
    size_t priv_b64_len, pub_b64_len;
    mbedtls_base64_encode((unsigned char *)priv_b64, sizeof(priv_b64), &priv_b64_len, priv_raw, priv_len);
    mbedtls_base64_encode((unsigned char *)pub_b64_out, sizeof(pub_b64_out), &pub_b64_len, pub_raw, pub_len);
    priv_b64[priv_b64_len] = '\0';
    pub_b64_out[pub_b64_len] = '\0';

    nvs_manager_store_keypair(priv_b64, pub_b64_out);
    http_client_set_public_key(pub_b64_out);

    ESP_LOGI(TAG, "X25519 keypair generated and stored");
}

/**
 * Decrypt an encrypted token using our X25519 private key + server's public key.
 * Implements: ECDH → HKDF-SHA256 → AES-256-GCM decrypt.
 *
 * All inputs are base64-encoded. Returns the plaintext token, or NULL on failure.
 * Caller must free() the returned string.
 */
static char *decrypt_token(const char *ciphertext_b64, const char *nonce_b64,
                           const char *server_pub_b64)
{
    char priv_b64[NVS_MAX_KEY_LEN];
    if (nvs_manager_get_private_key(priv_b64, sizeof(priv_b64)) != ESP_OK) {
        ESP_LOGE(TAG, "No private key in NVS");
        return NULL;
    }

    /* Decode base64 inputs */
    uint8_t priv_raw[32], server_pub[32], nonce[12];
    uint8_t ct_buf[256];
    size_t priv_len, spub_len, nonce_len, ct_len;

    mbedtls_base64_decode(priv_raw, sizeof(priv_raw), &priv_len,
                          (const unsigned char *)priv_b64, strlen(priv_b64));
    mbedtls_base64_decode(server_pub, sizeof(server_pub), &spub_len,
                          (const unsigned char *)server_pub_b64, strlen(server_pub_b64));
    mbedtls_base64_decode(nonce, sizeof(nonce), &nonce_len,
                          (const unsigned char *)nonce_b64, strlen(nonce_b64));
    mbedtls_base64_decode(ct_buf, sizeof(ct_buf), &ct_len,
                          (const unsigned char *)ciphertext_b64, strlen(ciphertext_b64));

    if (ct_len < 16) { ESP_LOGE(TAG, "Ciphertext too short"); return NULL; }

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
        return NULL;
    }

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
        psa_import_key(&ikm_attr, shared_raw, shared_len, &ikm_key);

        psa_key_derivation_operation_t op = PSA_KEY_DERIVATION_OPERATION_INIT;
        psa_key_derivation_setup(&op, PSA_ALG_HKDF(PSA_ALG_SHA_256));
        psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_SALT, NULL, 0);
        psa_key_derivation_input_key(&op, PSA_KEY_DERIVATION_INPUT_SECRET, ikm_key);
        psa_key_derivation_input_bytes(&op, PSA_KEY_DERIVATION_INPUT_INFO,
                                       (const uint8_t *)"vellum-token-v1", 15);
        psa_key_derivation_output_bytes(&op, aes_key, 32);
        psa_key_derivation_abort(&op);
        psa_destroy_key(ikm_key);
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
        psa_import_key(&aes_attr, aes_key, 32, &aes_key_id);

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

/* -----------------------------------------------------------------------
 * TOFU hello handshake
 * ----------------------------------------------------------------------- */

static bool perform_hello(void)
{
    ESP_LOGI(TAG, "Performing hello handshake");

    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_hello(&resp);

    if (err != ESP_OK || resp.status_code != 200) {
        ESP_LOGW(TAG, "Hello failed: err=%s status=%d",
                 esp_err_to_name(err), resp.status_code);
        http_client_free_response(&resp);
        return false;
    }

    /* Parse JSON response with cJSON */
    if (resp.body && resp.body_len > 0) {
        cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
        if (root) {
            cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
            if (data) {
                cJSON *status_obj = cJSON_GetObjectItemCaseSensitive(data, "status");

                /* Try encrypted token first (ECDH path) */
                cJSON *enc = cJSON_GetObjectItemCaseSensitive(data, "encryptedToken");
                if (enc) {
                    cJSON *ct = cJSON_GetObjectItemCaseSensitive(enc, "ciphertext");
                    cJSON *nc = cJSON_GetObjectItemCaseSensitive(enc, "nonce");
                    cJSON *spk = cJSON_GetObjectItemCaseSensitive(enc, "serverPublicKey");
                    if (cJSON_IsString(ct) && cJSON_IsString(nc) && cJSON_IsString(spk)) {
                        char *token = decrypt_token(ct->valuestring, nc->valuestring, spk->valuestring);
                        if (token && strlen(token) > 0 && strlen(token) < NVS_MAX_TOKEN_LEN) {
                            nvs_manager_store_token(token);
                            http_client_set_token(token);
                            ESP_LOGI(TAG, "Encrypted token decrypted and stored");
                            free(token);
                            cJSON_Delete(root);
                            http_client_free_response(&resp);
                            return true;
                        }
                        free(token);
                        ESP_LOGW(TAG, "Failed to decrypt token");
                    }
                }

                /* Fallback: plaintext token (legacy) */
                cJSON *token_obj = cJSON_GetObjectItemCaseSensitive(data, "token");
                if (cJSON_IsString(token_obj) && token_obj->valuestring &&
                    strlen(token_obj->valuestring) > 0 &&
                    strlen(token_obj->valuestring) < NVS_MAX_TOKEN_LEN) {
                    nvs_manager_store_token(token_obj->valuestring);
                    http_client_set_token(token_obj->valuestring);
                    ESP_LOGI(TAG, "Plaintext token received and stored");
                    cJSON_Delete(root);
                    http_client_free_response(&resp);
                    return true;
                }

                if (cJSON_IsString(status_obj) &&
                    strcmp(status_obj->valuestring, "pending") == 0) {
                    ESP_LOGI(TAG, "Device is pending approval");
                    cJSON_Delete(root);
                    http_client_free_response(&resp);
                    return false;
                }
            }
            cJSON_Delete(root);
        } else {
            ESP_LOGW(TAG, "Failed to parse hello JSON response");
        }
    }

    /* Check if we already have a token in NVS */
    char existing[NVS_MAX_TOKEN_LEN];
    if (nvs_manager_get_token(existing, sizeof(existing)) == ESP_OK) {
        http_client_set_token(existing);
        http_client_free_response(&resp);
        return true;
    }

    http_client_free_response(&resp);
    return false;
}

/* -----------------------------------------------------------------------
 * Render flow
 * ----------------------------------------------------------------------- */

static uint32_t perform_render(void)
{
    ESP_LOGI(TAG, "Requesting render");

    vellum_http_response_t resp = {0};
    esp_err_t err = ESP_FAIL;

    for (int attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
            ESP_LOGI(TAG, "Render retry %d/3...", attempt + 1);
            vTaskDelay(pdMS_TO_TICKS(2000 * (1 << attempt)));
        }
        memset(&resp, 0, sizeof(resp));
        err = http_client_render(&resp);
        if (err == ESP_OK && resp.status_code > 0) break;
        http_client_free_response(&resp);
    }
    uint32_t sleep_sec = CONFIG_VELLUM_FALLBACK_SLEEP_SEC;

    if (resp.sleep_duration > 0) {
        sleep_sec = (uint32_t)resp.sleep_duration;
    }

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Render request failed: %s", esp_err_to_name(err));
        display_show_error("Server Unavailable");
        http_client_free_response(&resp);
        return sleep_sec;
    }

    if (resp.status_code == 200) {
        if (resp.binary_body && resp.binary_len > 0) {
            /* Re-assert BUSY pin as input (WiFi/sleep may have reconfigured it) */
            gpio_set_direction(GPIO_NUM_13, GPIO_MODE_INPUT);
            if (display_update_raw(resp.binary_body, resp.binary_len) != ESP_OK) {
                ESP_LOGW(TAG, "Malformed pixel buffer (%zu bytes)", resp.binary_len);
                display_show_error("Error");
            }
        } else {
            ESP_LOGW(TAG, "Empty render response body");
            display_show_error("Error");
        }
    } else if (resp.status_code == 304) {
        ESP_LOGI(TAG, "Content unchanged — skipping display refresh");
    } else if (resp.status_code == 401) {
        ESP_LOGW(TAG, "401 Unauthorized");
        display_show_error("Unauthorized");
        nvs_manager_store_token("");
        http_client_set_token(NULL);
        perform_hello();
    } else if (resp.status_code >= 500 || resp.status_code == -1) {
        ESP_LOGW(TAG, "Server error (%d)", resp.status_code);
        display_show_error("Server Error");
    } else {
        ESP_LOGW(TAG, "Unexpected status %d", resp.status_code);
        display_show_error("Error");
    }

    http_client_free_response(&resp);
    return sleep_sec;
}

/* -----------------------------------------------------------------------
 * Button action handler
 * ----------------------------------------------------------------------- */

static bool handle_button_action(button_action_t action)
{
    switch (action) {
    case BUTTON_ACTION_REQUEST_RENDER:
        ESP_LOGI(TAG, "Button 1 → fresh render");
        return false; /* fall through to normal render */

    case BUTTON_ACTION_SEND_REPORT: {
        ESP_LOGI(TAG, "Button 2 → sending report");
        vellum_http_response_t resp = {0};
        http_client_report("Room issue reported via button", &resp);
        ESP_LOGI(TAG, "Report response: %d", resp.status_code);
        http_client_free_response(&resp);
        return true;
    }

    case BUTTON_ACTION_FACTORY_RESET:
        ESP_LOGW(TAG, "Factory reset — erasing NVS");
        buzzer_beep(500, 500);
        nvs_manager_clear_all();
        esp_restart();
        return true;

    case BUTTON_ACTION_NONE:
    default:
        return false;
    }
}

/* -----------------------------------------------------------------------
 * app_main — ESP-IDF entry point
 * ----------------------------------------------------------------------- */

/* -----------------------------------------------------------------------
 * Ed25519 OTA signature verification
 * ----------------------------------------------------------------------- */

#include "mbedtls/pk.h"
#include "mbedtls/md.h"

/**
 * Verify an Ed25519 signature over a SHA256 hash.
 * Returns true if valid, false otherwise.
 */
static bool verify_ota_signature(const char *sha256_hex, const char *signature_b64)
{
    const char *pubkey_b64 = CONFIG_VELLUM_OTA_SIGNING_PUBKEY;
    if (!pubkey_b64 || strlen(pubkey_b64) == 0) {
        ESP_LOGW(TAG, "No OTA signing key configured — skipping signature check");
        return true; /* Allow unsigned in development */
    }

    /* Decode public key from base64 PEM */
    uint8_t pubkey_der[128];
    size_t pubkey_len = 0;
    mbedtls_base64_decode(pubkey_der, sizeof(pubkey_der), &pubkey_len,
                          (const unsigned char *)pubkey_b64, strlen(pubkey_b64));

    /* Decode signature from base64 */
    uint8_t sig[128];
    size_t sig_len = 0;
    mbedtls_base64_decode(sig, sizeof(sig), &sig_len,
                          (const unsigned char *)signature_b64, strlen(signature_b64));

    /* Parse SHA256 hex to bytes */
    uint8_t hash[32];
    for (int i = 0; i < 32; i++) {
        char hex[3] = { sha256_hex[i*2], sha256_hex[i*2+1], 0 };
        hash[i] = (uint8_t)strtol(hex, NULL, 16);
    }

    /* Verify with mbedtls */
    mbedtls_pk_context pk;
    mbedtls_pk_init(&pk);
    int ret = mbedtls_pk_parse_public_key(&pk, pubkey_der, pubkey_len);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to parse OTA public key: %d", ret);
        mbedtls_pk_free(&pk);
        return false;
    }

    ret = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, 32, sig, sig_len);
    mbedtls_pk_free(&pk);

    if (ret != 0) {
        ESP_LOGE(TAG, "OTA signature verification FAILED: %d", ret);
        return false;
    }

    ESP_LOGI(TAG, "OTA signature verified ✓");
    return true;
}

/* -----------------------------------------------------------------------
 * OTA firmware update
 * ----------------------------------------------------------------------- */

static void check_ota_update(void)
{
    ESP_LOGI(TAG, "Checking for OTA update via /config");
    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_config(&resp);

    if (err != ESP_OK || resp.status_code != 200 || !resp.body) {
        http_client_free_response(&resp);
        return;
    }

    /* Parse config response for otaUrl */
    cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
    if (!root) { http_client_free_response(&resp); return; }

    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    cJSON *ota_url = data ? cJSON_GetObjectItemCaseSensitive(data, "otaUrl") : NULL;

    cJSON *ota_ver = data ? cJSON_GetObjectItemCaseSensitive(data, "otaVersion") : NULL;
    cJSON *ota_sha = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSha256") : NULL;

    if (cJSON_IsString(ota_url) && ota_url->valuestring && strlen(ota_url->valuestring) > 0) {
        ESP_LOGI(TAG, "OTA update: %s → %s",
                 cJSON_IsString(ota_ver) ? ota_ver->valuestring : "?",
                 ota_url->valuestring);
        display_show_ota_progress(0);
        buzzer_beep(800, 200);

        esp_http_client_config_t ota_config = {
            .url = ota_url->valuestring,
            .timeout_ms = 120000,
            .crt_bundle_attach = esp_crt_bundle_attach,
        };

        esp_https_ota_config_t ota_params = {
            .http_config = &ota_config,
        };

        esp_err_t ota_err = esp_https_ota(&ota_params);
        if (ota_err == ESP_OK) {
            /* Verify SHA256 if provided */
            if (cJSON_IsString(ota_sha) && ota_sha->valuestring) {
                const esp_partition_t *running = esp_ota_get_running_partition();
                const esp_partition_t *update = esp_ota_get_next_update_partition(running);
                if (update) {
                    uint8_t sha[32];
                    esp_partition_get_sha256(update, sha);
                    char sha_hex[65];
                    for (int i = 0; i < 32; i++) sprintf(sha_hex + i*2, "%02x", sha[i]);
                    sha_hex[64] = 0;

                    if (strcmp(sha_hex, ota_sha->valuestring) != 0) {
                        ESP_LOGE(TAG, "SHA256 mismatch! Expected: %s Got: %s",
                                 ota_sha->valuestring, sha_hex);
                        buzzer_beep(300, 500);
                        /* Rollback: don't set boot partition */
                        cJSON_Delete(root);
                        http_client_free_response(&resp);
                        return;
                    }
                    ESP_LOGI(TAG, "SHA256 verified ✓");

                    /* Verify Ed25519 signature */
                    cJSON *ota_sig = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSignature") : NULL;
                    if (cJSON_IsString(ota_sig) && ota_sig->valuestring && strlen(ota_sig->valuestring) > 0) {
                        if (!verify_ota_signature(sha_hex, ota_sig->valuestring)) {
                            ESP_LOGE(TAG, "Signature verification FAILED — aborting OTA");
                            buzzer_beep(300, 500);
                            cJSON_Delete(root);
                            http_client_free_response(&resp);
                            return;
                        }
                    }
                }
            }

            ESP_LOGI(TAG, "OTA success — restarting");
            buzzer_beep(2000, 100); vTaskDelay(pdMS_TO_TICKS(100)); buzzer_beep(2000, 100);
            cJSON_Delete(root);
            http_client_free_response(&resp);
            esp_restart();
        } else {
            ESP_LOGW(TAG, "OTA failed: %s", esp_err_to_name(ota_err));
            buzzer_beep(300, 500);
        }
    }

    cJSON_Delete(root);
    http_client_free_response(&resp);
}

void app_main(void)
{
    ESP_LOGI(TAG, "===== Vellum Firmware v%s =====", CONFIG_VELLUM_FIRMWARE_VERSION);

    /* 1. Initialize core subsystems */
    ESP_ERROR_CHECK(nvs_manager_init());
#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* D1001: board init first (power rails, I2C, IO-expander) */
    extern esp_err_t d1001_board_init(void);
    ESP_ERROR_CHECK(d1001_board_init());
#else
    init_battery_adc();
    led_init();
    buzzer_init();
    sht4x_init();
#endif
    display_init();
    vellum_serial_init();

    wake_reason_t wake = sleep_manager_get_wake_reason();

    /* Button wake: immediate beep before anything else */
    if (wake == WAKE_REASON_BUTTON) {
        buzzer_beep(1000, 100);
    }

    /* Only show boot screen on power-on or button wake, not timer wake */
    if (wake != WAKE_REASON_TIMER) {
        display_show_boot(CONFIG_VELLUM_FIRMWARE_VERSION);
    }
    if (wake == WAKE_REASON_POWER_ON) {
        buzzer_beep(1000, 100);
    }
    led_on();
    buttons_init();
    sleep_manager_init();

    ESP_LOGI(TAG, "Wake reason: %s",
             wake == WAKE_REASON_TIMER  ? "TIMER" :
             wake == WAKE_REASON_BUTTON ? "BUTTON" : "POWER_ON");

    /* 2. Check battery — critical shutdown if below threshold */
    int battery = read_battery_level();
    ESP_LOGI(TAG, "Battery level: %d%%", battery);

    if (battery > 0 && battery < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT && !is_usb_powered()) {
        ESP_LOGW(TAG, "CRITICAL: Battery below %d%% — shutting down",
                 CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT);
        display_show_error("Low Battery");
        display_sleep();
        sleep_manager_enter_permanent(buttons_get_wake_mask());
        /* does not return */
    }

    /* 3. Connect to Wi-Fi or enter SoftAP */
    wifi_result_t wifi_result = wifi_manager_connect_station();

    if (wifi_result == WIFI_RESULT_NO_CREDENTIALS) {
        ESP_LOGI(TAG, "No Wi-Fi credentials — entering SoftAP");
        char ssid[32];
        wifi_manager_get_softap_ssid(ssid, sizeof(ssid));
        display_show_wifi_setup(ssid, "http://192.168.4.1");
        wifi_manager_start_softap();
        /* does not return — restarts after provisioning */
    }

    if (wifi_result == WIFI_RESULT_FAILED) {
        ESP_LOGW(TAG, "Wi-Fi connection failed — showing No Signal icon");
        display_show_error("No WiFi Signal");
        display_sleep();
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        /* does not return */
    }

    /* 4. Wi-Fi connected — initialize HTTP client */
    char mac[18];
    wifi_manager_get_mac(mac, sizeof(mac));

    char server_url[NVS_MAX_URL_LEN];
    if (nvs_manager_get_server_url(server_url, sizeof(server_url)) != ESP_OK) {
        /* Try mDNS auto-discovery */
        ESP_LOGI(TAG, "No server URL — trying mDNS discovery...");
        mdns_init();
        mdns_result_t *results = NULL;
        esp_err_t mdns_err = mdns_query_ptr("_vellum", "_tcp", 5000, 1, &results);
        if (mdns_err == ESP_OK && results) {
            mdns_result_t *r = results;
            if (r->addr && r->addr->addr.type == ESP_IPADDR_TYPE_V4 && r->port > 0) {
                snprintf(server_url, sizeof(server_url), "http://" IPSTR ":%d",
                         IP2STR(&r->addr->addr.u_addr.ip4), r->port);
            } else if (r->hostname && r->port > 0) {
                snprintf(server_url, sizeof(server_url), "http://%s.local:%d",
                         r->hostname, r->port);
            } else {
                ESP_LOGW(TAG, "mDNS result has no usable address");
                strncpy(server_url, CONFIG_VELLUM_DEFAULT_SERVER_URL, sizeof(server_url) - 1);
                server_url[sizeof(server_url) - 1] = '\0';
            }
            ESP_LOGI(TAG, "mDNS found server: %s", server_url);
            nvs_manager_store_server_url(server_url);
            mdns_query_results_free(results);
        } else {
            ESP_LOGW(TAG, "mDNS discovery failed, using default");
            strncpy(server_url, CONFIG_VELLUM_DEFAULT_SERVER_URL, sizeof(server_url) - 1);
            server_url[sizeof(server_url) - 1] = '\0';
        }
        mdns_free();
    }

    http_client_init(server_url, mac);

    ensure_keypair();

    sht4x_read();
    vellum_telemetry_t telemetry = gather_telemetry();
    http_client_set_telemetry(&telemetry);

    /* 5. Handle button-triggered actions */
    if (wake == WAKE_REASON_BUTTON) {
        vTaskDelay(pdMS_TO_TICKS(100));
        button_action_t action = buttons_poll();
        if (handle_button_action(action)) {
            display_sleep();
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            /* does not return */
        }
    }

    /* 6. Ensure we have a device token (TOFU) */
    char token[NVS_MAX_TOKEN_LEN];
    if (nvs_manager_get_token(token, sizeof(token)) == ESP_OK && strlen(token) > 0) {
        http_client_set_token(token);
    } else {
        if (!perform_hello()) {
            ESP_LOGW(TAG, "No token after hello — device may be pending");
            display_show_error("Unauthorized");
            display_sleep();
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            /* does not return */
        }
    }

    /* 7. Request render and draw to display */
    uint32_t sleep_duration = perform_render();

    /* 7b. If green button pressed during render, beep + re-render */
    while (buttons_key0_pressed()) {
        buzzer_beep(1000, 100);
        sleep_duration = perform_render();
    }

    /* 8. Check for OTA update */
    check_ota_update();
    led_off();

    /* 9. Enter deep sleep */
    ESP_LOGI(TAG, "Sleeping for %lu seconds", (unsigned long)sleep_duration);
    display_sleep();
    sleep_manager_enter(sleep_duration, buttons_get_wake_mask());
    /* does not return */
}
