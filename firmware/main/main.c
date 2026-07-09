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
#include "esp_sleep.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "cJSON.h"

#include "nvs_manager.h"
#include "wifi_manager.h"
#include "http_client.h"
#include "vellum_display.h"
#include "buttons.h"
#include "sleep_manager.h"
#include "vellum_serial.h"
#include "mdns.h"
#include "board.h"
#include "secure_channel.h"
#include "ota_manager.h"

static const char *TAG = "vellum_main";

static vellum_telemetry_t gather_telemetry(void)
{
    vellum_telemetry_t t = {
        .battery_voltage = board_battery_voltage(),
        .battery_level   = board_battery_level(),
        .wifi_rssi       = wifi_manager_get_rssi(),
        .firmware_ver    = CONFIG_VELLUM_FIRMWARE_VERSION,
    };
    return t;
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
                        char *token = secure_channel_decrypt_token(ct->valuestring, nc->valuestring, spk->valuestring);
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
#if !defined(CONFIG_VELLUM_PANEL_D1001)
            /* Re-assert the E-Paper BUSY pin (GPIO13) as input — WiFi/sleep may
             * have reconfigured it. NOT on D1001: there GPIO13 is the ESP32-C6
             * Wi-Fi reset line, and this runs on every render. */
            gpio_set_direction(GPIO_NUM_13, GPIO_MODE_INPUT);
#endif
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
        board_buzzer_beep(500, 500);
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

#ifdef CONFIG_VELLUM_BUTTON_ACTIVE_HIGH
  #define PRESSED_LEVEL 1
#else
  #define PRESSED_LEVEL 0
#endif

volatile bool s_button_pressed = false;

#if defined(CONFIG_VELLUM_PANEL_D1001)
static void d1001_button_task(void *arg)
{
    (void)arg;
    gpio_num_t btn = (gpio_num_t)CONFIG_VELLUM_BUTTON_KEY0_GPIO;
    /* Wait for button release after boot */
    while (gpio_get_level(btn) == PRESSED_LEVEL) vTaskDelay(pdMS_TO_TICKS(50));
    vTaskDelay(pdMS_TO_TICKS(500));

    while (1) {
        if (gpio_get_level(btn) == PRESSED_LEVEL) {
            int64_t start = esp_timer_get_time();
            int last_cd = -1;
            while (gpio_get_level(btn) == PRESSED_LEVEL) {
                int64_t held = (esp_timer_get_time() - start) / 1000;
                if (held >= 5000) {
                    int rem = (int)((10000 - held) / 1000);
                    if (rem < 0) rem = 0;
                    if (rem != last_cd) {
                        char msg[48];
                        snprintf(msg, sizeof(msg), "Factory Reset in %d", rem);
                        display_show_error(msg);
                        last_cd = rem;
                    }
                }
                if (held >= 10000) {
                    display_show_error("Factory Reset...");
                    vTaskDelay(pdMS_TO_TICKS(500));
                    nvs_flash_erase();
                    esp_restart();
                }
                vTaskDelay(pdMS_TO_TICKS(50));
            }
            int64_t held = (esp_timer_get_time() - start) / 1000;
            if (held >= 5000) {
                /* Released between 5-10s: reboot */
                esp_restart();
            }
            /* Short press (<5s): trigger immediate refresh/retry */
            s_button_pressed = true;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
#endif

void app_main(void)
{
    ESP_LOGI(TAG, "===== Vellum Firmware v%s =====", CONFIG_VELLUM_FIRMWARE_VERSION);

    /* 1. Initialize core subsystems */
    ESP_ERROR_CHECK(nvs_manager_init());
#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* D1001: board init first (power rails, I2C, IO-expander) */
    extern esp_err_t d1001_board_init(void);
    extern esp_err_t d1001_backlight_on(void);
    ESP_ERROR_CHECK(d1001_board_init());
    d1001_backlight_on();
#else
    board_init();

    /* Immediate beep on button wake (before slow display init) */
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT1) {
        board_buzzer_beep(1000, 100);
    }
#endif
    display_init();
    vellum_serial_init();
#if defined(CONFIG_VELLUM_PANEL_D1001)
    xTaskCreate(d1001_button_task, "d1001_btn", 4096, NULL, 5, NULL);
#endif

    wake_reason_t wake = sleep_manager_get_wake_reason();

    /* Only show boot screen on first power-on */
    if (wake == WAKE_REASON_POWER_ON) {
        display_show_boot(CONFIG_VELLUM_FIRMWARE_VERSION);
        board_buzzer_beep(1000, 100);
    }
    board_led_on();
    buttons_init();
    sleep_manager_init();

    /* Factory reset: if KEY0 held at boot on fast-refresh displays */
#if !defined(CONFIG_VELLUM_PANEL_D1001)
    if (wake == WAKE_REASON_BUTTON && gpio_get_level(CONFIG_VELLUM_BUTTON_KEY0_GPIO) == PRESSED_LEVEL) {
        ESP_LOGI(TAG, "KEY0 held at boot — checking for factory reset");
        int held_ms = 0;
        while (gpio_get_level(CONFIG_VELLUM_BUTTON_KEY0_GPIO) == PRESSED_LEVEL && held_ms < 10000) {
            if (held_ms >= 3000) {
                int rem = (10000 - held_ms) / 1000;
                char msg[32];
                snprintf(msg, sizeof(msg), "Factory Reset in %d", rem);
                display_show_error(msg);
            }
            vTaskDelay(pdMS_TO_TICKS(200));
            held_ms += 200;
        }
        if (held_ms >= 10000) {
            display_show_error("Factory Reset...");
            vTaskDelay(pdMS_TO_TICKS(500));
            nvs_flash_erase();
            esp_restart();
        } else if (held_ms >= 3000) {
            /* Released between 3-10s: just reboot */
            esp_restart();
        }
        /* Released before 3s: normal boot */
    }
#endif

    ESP_LOGI(TAG, "Wake reason: %s",
             wake == WAKE_REASON_TIMER  ? "TIMER" :
             wake == WAKE_REASON_BUTTON ? "BUTTON" : "POWER_ON");

    /* 2. Check battery — critical shutdown if below threshold */
    int battery = board_battery_level();
    ESP_LOGI(TAG, "Battery level: %d%%", battery);

    if (battery > 0 && battery < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT && !board_is_usb_powered()) {
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
        char qr_payload[64];
        snprintf(qr_payload, sizeof(qr_payload), "WIFI:T:nopass;S:%s;;", ssid);
        display_show_wifi_setup(ssid, qr_payload);
        wifi_manager_start_softap();
        /* does not return — restarts after provisioning */
    }

    if (wifi_result == WIFI_RESULT_FAILED) {
        ESP_LOGW(TAG, "Wi-Fi connection failed");
        display_show_error("No WiFi Signal");
        display_sleep();
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        /* On E-Paper: does not return. On D1001: returns, then restart to re-init WiFi */
        esp_restart();
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
            /* Public-CA TLS validates against a hostname (cert CN/SAN), never a
             * bare IP, so we only accept a discovered hostname and always use
             * https://. The advertised host must present a valid certificate. */
            if (r->hostname && r->port > 0) {
                snprintf(server_url, sizeof(server_url), "https://%s.local:%d",
                         r->hostname, r->port);
            } else {
                ESP_LOGW(TAG, "mDNS result unusable for TLS (no hostname) — using default");
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

    char pubkey_b64[NVS_MAX_KEY_LEN];
    if (secure_channel_ensure_keypair(pubkey_b64, sizeof(pubkey_b64)) == ESP_OK) {
        http_client_set_public_key(pubkey_b64);
    }

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
        while (!perform_hello()) {
            ESP_LOGW(TAG, "No token after hello — device may be pending or server unreachable");
            display_show_error("No Server");
            display_sleep();
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            /* On D1001 this returns after delay; on E-Paper it does not return */
        }
    }

    /* 7. Request render and draw to display */
    uint32_t sleep_duration = perform_render();

    /* Reaching a successful render confirms WiFi + server + token + display all
     * work — a good-enough signal to confirm a freshly-OTA'd image and cancel
     * the bootloader rollback (no-op unless this image is PENDING_VERIFY). */
    ota_manager_mark_valid();

    /* 7b. If green button pressed during render, beep + re-render */
    while (buttons_key0_pressed()) {
        board_buzzer_beep(1000, 100);
        sleep_duration = perform_render();
    }

    /* 8. Check for OTA update */
    ota_manager_check_and_apply();
    board_led_off();

#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* LCD: poll loop instead of deep sleep */
    ESP_LOGI(TAG, "Polling every %lu seconds", (unsigned long)sleep_duration);
    while (1) {
        for (uint32_t i = 0; i < sleep_duration && !s_button_pressed; i++) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
        if (s_button_pressed) {
            s_button_pressed = false;
            ESP_LOGI(TAG, "Button → immediate refresh");
        }
        sleep_duration = perform_render();
        ota_manager_check_and_apply();
    }
#else
    /* 9. Enter deep sleep (E-Paper) */
    ESP_LOGI(TAG, "Sleeping for %lu seconds", (unsigned long)sleep_duration);
    display_sleep();
    sleep_manager_enter(sleep_duration, buttons_get_wake_mask());
    /* does not return */
#endif
}
