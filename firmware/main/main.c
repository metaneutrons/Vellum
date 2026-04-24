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

#include "mbedtls/ecdh.h"
#include "mbedtls/hkdf.h"
#include "mbedtls/gcm.h"
#include "mbedtls/md.h"
#include "mbedtls/entropy.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/base64.h"

#include "nvs_manager.h"
#include "wifi_manager.h"
#include "http_client.h"
#include "vellum_display.h"
#include "buttons.h"
#include "sleep_manager.h"

static const char *TAG = "vellum_main";

/* -----------------------------------------------------------------------
 * Hardware — Battery, LED, Buzzer (reTerminal E Series)
 * ----------------------------------------------------------------------- */

#include "esp_adc/adc_oneshot.h"
#include "driver/ledc.h"

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
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 0);
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

    mbedtls_entropy_context entropy;
    mbedtls_ctr_drbg_context ctr_drbg;
    mbedtls_ecdh_context ecdh;

    mbedtls_entropy_init(&entropy);
    mbedtls_ctr_drbg_init(&ctr_drbg);
    mbedtls_ecdh_init(&ecdh);

    mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                          (const unsigned char *)"vellum", 6);
    mbedtls_ecdh_setup(&ecdh, MBEDTLS_ECP_DP_CURVE25519);
    mbedtls_ecdh_gen_public(&ecdh.MBEDTLS_PRIVATE(grp),
                            &ecdh.MBEDTLS_PRIVATE(d),
                            &ecdh.MBEDTLS_PRIVATE(Q),
                            mbedtls_ctr_drbg_random, &ctr_drbg);

    /* Export raw 32-byte keys */
    uint8_t priv_raw[32], pub_raw[32];
    size_t olen;
    mbedtls_mpi_write_binary(&ecdh.MBEDTLS_PRIVATE(d), priv_raw, 32);
    mbedtls_ecp_point_write_binary(&ecdh.MBEDTLS_PRIVATE(grp),
                                   &ecdh.MBEDTLS_PRIVATE(Q),
                                   MBEDTLS_ECP_PF_COMPRESSED, &olen, pub_raw, 32);

    /* Base64 encode */
    char priv_b64[NVS_MAX_KEY_LEN], pub_b64_out[NVS_MAX_KEY_LEN];
    size_t priv_len, pub_len;
    mbedtls_base64_encode((unsigned char *)priv_b64, sizeof(priv_b64), &priv_len, priv_raw, 32);
    mbedtls_base64_encode((unsigned char *)pub_b64_out, sizeof(pub_b64_out), &pub_len, pub_raw, 32);
    priv_b64[priv_len] = '\0';
    pub_b64_out[pub_len] = '\0';

    nvs_manager_store_keypair(priv_b64, pub_b64_out);
    http_client_set_public_key(pub_b64_out);

    mbedtls_ecdh_free(&ecdh);
    mbedtls_ctr_drbg_free(&ctr_drbg);
    mbedtls_entropy_free(&entropy);

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

    /* ECDH: compute shared secret */
    mbedtls_ecdh_context ecdh;
    mbedtls_ecdh_init(&ecdh);
    mbedtls_ecdh_setup(&ecdh, MBEDTLS_ECP_DP_CURVE25519);
    mbedtls_mpi_read_binary(&ecdh.MBEDTLS_PRIVATE(d), priv_raw, 32);
    mbedtls_ecp_point_read_binary(&ecdh.MBEDTLS_PRIVATE(grp),
                                  &ecdh.MBEDTLS_PRIVATE(Qp), server_pub, 32);

    mbedtls_mpi shared;
    mbedtls_mpi_init(&shared);
    mbedtls_ecdh_compute_shared(&ecdh.MBEDTLS_PRIVATE(grp), &shared,
                                &ecdh.MBEDTLS_PRIVATE(Qp),
                                &ecdh.MBEDTLS_PRIVATE(d), NULL, NULL);

    uint8_t shared_raw[32];
    mbedtls_mpi_write_binary(&shared, shared_raw, 32);
    mbedtls_mpi_free(&shared);
    mbedtls_ecdh_free(&ecdh);

    /* HKDF-SHA256: derive AES key */
    uint8_t aes_key[32];
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_hkdf(md, NULL, 0, shared_raw, 32,
                 (const unsigned char *)"vellum-token-v1", 15, aes_key, 32);

    /* AES-256-GCM decrypt */
    size_t plaintext_len = ct_len - 16; /* last 16 bytes = auth tag */
    uint8_t *plaintext = malloc(plaintext_len + 1);
    if (!plaintext) return NULL;

    mbedtls_gcm_context gcm;
    mbedtls_gcm_init(&gcm);
    mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, aes_key, 256);

    int ret = mbedtls_gcm_auth_decrypt(&gcm, plaintext_len,
                                       nonce, nonce_len,
                                       NULL, 0,
                                       ct_buf + plaintext_len, 16, /* tag */
                                       ct_buf, plaintext);
    mbedtls_gcm_free(&gcm);

    if (ret != 0) {
        ESP_LOGE(TAG, "AES-GCM decrypt failed: %d", ret);
        free(plaintext);
        return NULL;
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
    display_show_loading();

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
    display_show_loading();

    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_render(&resp);
    uint32_t sleep_sec = CONFIG_VELLUM_FALLBACK_SLEEP_SEC;

    if (resp.sleep_duration > 0) {
        sleep_sec = (uint32_t)resp.sleep_duration;
    }

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Render request failed: %s", esp_err_to_name(err));
        display_draw_fallback_icon(ICON_CLOUD_DISCONNECT);
        http_client_free_response(&resp);
        return sleep_sec;
    }

    if (resp.status_code == 200) {
        if (resp.binary_body && resp.binary_len > 0) {
            if (!display_draw_pixel_buffer(resp.binary_body, resp.binary_len)) {
                ESP_LOGW(TAG, "Malformed pixel buffer (%zu bytes)", resp.binary_len);
                display_draw_fallback_icon(ICON_ERROR);
            }
        } else {
            ESP_LOGW(TAG, "Empty render response body");
            display_draw_fallback_icon(ICON_ERROR);
        }
    } else if (resp.status_code == 401) {
        ESP_LOGW(TAG, "401 Unauthorized");
        display_draw_fallback_icon(ICON_UNAUTHORIZED);
        nvs_manager_store_token("");
        http_client_set_token(NULL);
        perform_hello();
    } else if (resp.status_code >= 500 || resp.status_code == -1) {
        ESP_LOGW(TAG, "Server error (%d)", resp.status_code);
        display_draw_fallback_icon(ICON_CLOUD_DISCONNECT);
    } else {
        ESP_LOGW(TAG, "Unexpected status %d", resp.status_code);
        display_draw_fallback_icon(ICON_ERROR);
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
        display_show_loading();
        vellum_http_response_t resp = {0};
        http_client_report("Room issue reported via button", &resp);
        ESP_LOGI(TAG, "Report response: %d", resp.status_code);
        http_client_free_response(&resp);
        return true;
    }

    case BUTTON_ACTION_ENTER_SOFTAP: {
        ESP_LOGI(TAG, "Button 3 held → entering SoftAP");
        char ssid[32];
        wifi_manager_get_softap_ssid(ssid, sizeof(ssid));
        display_draw_qr_code(ssid);
        wifi_manager_start_softap(); /* blocks, then restarts */
        return true;
    }

    case BUTTON_ACTION_NONE:
    default:
        return false;
    }
}

/* -----------------------------------------------------------------------
 * app_main — ESP-IDF entry point
 * ----------------------------------------------------------------------- */

void app_main(void)
{
    ESP_LOGI(TAG, "===== Vellum Firmware v%s =====", CONFIG_VELLUM_FIRMWARE_VERSION);

    /* 1. Initialize core subsystems */
    ESP_ERROR_CHECK(nvs_manager_init());
    init_battery_adc();
    led_init();
    buzzer_init();
    display_init();
    display_show_boot_logo();
    buzzer_beep(1000, 100); /* Boot beep */
    led_on();
    buttons_init();
    sleep_manager_init();

    wake_reason_t wake = sleep_manager_get_wake_reason();
    ESP_LOGI(TAG, "Wake reason: %s",
             wake == WAKE_REASON_TIMER  ? "TIMER" :
             wake == WAKE_REASON_BUTTON ? "BUTTON" : "POWER_ON");

    /* 2. Check battery — critical shutdown if below threshold */
    int battery = read_battery_level();
    ESP_LOGI(TAG, "Battery level: %d%%", battery);

    if (battery < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT && !is_usb_powered()) {
        ESP_LOGW(TAG, "CRITICAL: Battery below %d%% — shutting down",
                 CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT);
        display_draw_fallback_icon(ICON_CONNECT_POWER);
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
        display_draw_qr_code(ssid);
        wifi_manager_start_softap();
        /* does not return — restarts after provisioning */
    }

    if (wifi_result == WIFI_RESULT_FAILED) {
        ESP_LOGW(TAG, "Wi-Fi connection failed — showing No Signal icon");
        display_draw_fallback_icon(ICON_NO_SIGNAL);
        display_sleep();
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        /* does not return */
    }

    /* 4. Wi-Fi connected — initialize HTTP client */
    char mac[18];
    wifi_manager_get_mac(mac, sizeof(mac));

    char server_url[NVS_MAX_URL_LEN];
    if (nvs_manager_get_server_url(server_url, sizeof(server_url)) != ESP_OK) {
        ESP_LOGW(TAG, "No server URL in NVS, using default");
        strncpy(server_url, CONFIG_VELLUM_DEFAULT_SERVER_URL, sizeof(server_url) - 1);
        server_url[sizeof(server_url) - 1] = '\0';
    }

    http_client_init(server_url, mac);

    ensure_keypair();

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
            display_draw_fallback_icon(ICON_UNAUTHORIZED);
            display_sleep();
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            /* does not return */
        }
    }

    /* 7. Request render and draw to display */
    uint32_t sleep_duration = perform_render();

    /* 8. Enter deep sleep */
    ESP_LOGI(TAG, "Sleeping for %lu seconds", (unsigned long)sleep_duration);
    display_sleep();
    sleep_manager_enter(sleep_duration, buttons_get_wake_mask());
    /* does not return */
}
