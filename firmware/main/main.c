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
#include <time.h>
#include <sys/time.h>

#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "esp_netif_sntp.h"
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
#include "render_backoff.h"
#include "vellum_serial.h"
#include "mdns.h"
#include "board.h"
#include "secure_channel.h"
#include "ota_manager.h"
#if defined(CONFIG_VELLUM_PANEL_D1001)
#include "d1001_board.h"
#endif

/* The default time policy enables DHCP option 42 before association and falls
 * back to PTB when the lease supplies no server. Keeping this as a compile-time
 * invariant prevents a target-specific sdkconfig from turning that valid
 * runtime path into ESP_ERR_INVALID_ARG and a retry/reboot loop. */
#if !CONFIG_LWIP_DHCP_GET_NTP_SRV
#error "Vellum requires CONFIG_LWIP_DHCP_GET_NTP_SRV for its default NTP policy"
#endif

static const char *TAG = "vellum_main";

/* Certificates cannot be validated safely until the RTC has a real date.
 * A provisioned NTP server is an explicit administrator override. Otherwise,
 * DHCP option 42 is preferred and PTB's UTC(PTB) servers are fallbacks. */
#define VELLUM_MIN_VALID_UNIX_TIME 1704067200LL /* 2024-01-01T00:00:00Z */

static bool system_time_is_valid(void)
{
    time_t now = time(NULL);
    return (int64_t)now >= VELLUM_MIN_VALID_UNIX_TIME;
}

static void time_sync_completed(struct timeval *tv)
{
#if defined(CONFIG_VELLUM_PANEL_D1001)
    if (tv && d1001_rtc_set_time(tv->tv_sec) != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist synchronized time to D1001 RTC");
    }
#else
    (void)tv;
#endif
}

static bool time_sync_prepare(void)
{
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        3, ESP_SNTP_SERVER_LIST("ptbtime1.ptb.de", "ptbtime2.ptb.de", "ptbtime3.ptb.de"));
    /* esp-netif retains the server-name pointer after initialization, so this
     * must outlive this setup function. */
    static char provisioned_server[NVS_MAX_NTP_SERVER_LEN];
    provisioned_server[0] = '\0';
    if (nvs_manager_get_ntp_server(provisioned_server, sizeof(provisioned_server)) == ESP_OK &&
        provisioned_server[0]) {
        /* An explicit provisioning choice must be deterministic: do not let a
         * DHCP lease or fallback server silently replace the configured source. */
        config.servers[0] = provisioned_server;
        config.num_of_servers = 1;
        config.server_from_dhcp = false;
        ESP_LOGI(TAG, "Using provisioned NTP server");
    } else {
        config.server_from_dhcp = true;
    }
    config.sync_cb = time_sync_completed;
    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "Unable to initialize NTP: %s", esp_err_to_name(err));
        return false;
    }
    return true;
}

static bool time_sync_wait_for_valid_clock(void)
{
    if (system_time_is_valid()) return true;

    /* lwIP may defer the very first SNTP probe while the DHCP lease settles.
     * This is a boot-only wait; once synchronized the clock is reused. */
    const int max_attempts = 25;
    for (int attempt = 1; attempt <= max_attempts; ++attempt) {
        if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(2000)) == ESP_OK &&
            system_time_is_valid()) {
            ESP_LOGI(TAG, "System clock synchronized via NTP");
            return true;
        }
        ESP_LOGI(TAG, "Waiting for NTP time (%d/%d)", attempt, max_attempts);
    }
    return system_time_is_valid();
}

/* A USB-powered display must remain usable for Web Serial provisioning and
 * diagnostics. Keeping the panel awake matches the MCU sleep policy in
 * sleep_manager_enter() and avoids making a cabled error screen disappear. */
static void display_sleep_unless_usb_powered(void)
{
    if (board_is_usb_powered()) {
        ESP_LOGI(TAG, "External USB power present; keeping display awake");
        return;
    }
    display_sleep();
}

/** Build a display-safe server URL. Credentials are never expected in Vellum
 * URLs, but redact RFC 3986 userinfo defensively before putting it on a public
 * room display. */
static void display_server_url(char *out, size_t out_len)
{
    char url[NVS_MAX_URL_LEN] = {0};
    if (nvs_manager_get_server_url(url, sizeof(url)) != ESP_OK || !url[0]) {
        strlcpy(url, CONFIG_VELLUM_DEFAULT_SERVER_URL, sizeof(url));
    }

    const char *scheme = strstr(url, "://");
    const char *authority = scheme ? scheme + 3 : url;
    const char *at = strchr(authority, '@');
    const char *path = strchr(authority, '/');
    if (at && (!path || at < path)) {
        size_t prefix_len = (size_t)(authority - url);
        snprintf(out, out_len, "%.*s***@%s", (int)prefix_len, url, at + 1);
    } else {
        strlcpy(out, url, out_len);
    }
}

/* Keep operational details private: the room display gets a concise recovery
 * instruction, while exact mbedTLS codes remain in the USB serial log. */
static void display_transport_error(vellum_http_failure_t failure)
{
    char safe_url[NVS_MAX_URL_LEN];
    char message[NVS_MAX_URL_LEN + 72];
    display_server_url(safe_url, sizeof(safe_url));

    if (failure == VELLUM_HTTP_FAILURE_TLS_CERTIFICATE) {
        snprintf(message, sizeof(message),
                 "Secure connection failed\nCheck server certificate\n%s", safe_url);
    } else if (failure == VELLUM_HTTP_FAILURE_TLS_HANDSHAKE) {
        snprintf(message, sizeof(message),
                 "Secure connection failed\nCheck server TLS settings\n%s", safe_url);
    } else {
        snprintf(message, sizeof(message), "Server unavailable\n%s", safe_url);
    }
    display_show_error(message);
}

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

static bool perform_hello(vellum_http_failure_t *failure)
{
    if (failure) *failure = VELLUM_HTTP_FAILURE_NONE;
    ESP_LOGI(TAG, "Performing hello handshake");

    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_hello(&resp);

    if (err != ESP_OK || resp.status_code != 200) {
        ESP_LOGW(TAG, "Hello failed: err=%s status=%d",
                 esp_err_to_name(err), resp.status_code);
        if (failure) *failure = resp.failure;
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

/* Renders the current content. `render_ok` (nullable) is set true ONLY on a
 * genuinely successful round-trip (200 with a drawn frame, or a legitimate 304)
 * — the caller uses it to decide whether to confirm a freshly-OTA'd image. */
/* Consecutive failed render cycles. RTC memory so the streak survives deep
 * sleep — normal statics are reset on every wake, which would make the backoff
 * a no-op on the e-paper models. */
RTC_DATA_ATTR static uint32_t s_render_failures;

/* Pace retries: a healthy cycle keeps the server's cadence, each failure
 * doubles the wait up to the configured cap. */
static uint32_t pace_retry(uint32_t base_sec, bool ok)
{
    if (ok) {
        if (s_render_failures > 0) {
            ESP_LOGI(TAG, "Render recovered after %lu failed cycle(s)",
                     (unsigned long)s_render_failures);
        }
        s_render_failures = 0;
        return base_sec;
    }
    if (s_render_failures < UINT32_MAX) s_render_failures++;
    uint32_t delay = render_backoff_delay(base_sec, s_render_failures,
                                          CONFIG_VELLUM_ERROR_BACKOFF_MAX_SEC);
    if (delay != base_sec) {
        ESP_LOGW(TAG, "Backing off after %lu consecutive failure(s): %lu s instead of %lu s",
                 (unsigned long)s_render_failures, (unsigned long)delay,
                 (unsigned long)base_sec);
    }
    return delay;
}

static uint32_t perform_render(bool *render_ok)
{
    bool ok = false;
    if (render_ok) *render_ok = false;
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
        /* A dropped Wi-Fi association and an unreachable backend both surface as
         * HTTP transport failures. Check association before blaming the server,
         * so a public display gives operators an actionable diagnosis. */
        if (!wifi_manager_is_connected()) {
            display_show_wifi_error("Wi-Fi connection was lost", sleep_sec);
        } else {
            display_transport_error(resp.failure);
        }
        http_client_free_response(&resp);
        return pace_retry(sleep_sec, false);
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
            } else {
                ok = true;           /* frame drawn successfully */
                if (render_ok) *render_ok = true;
            }
        } else {
            ESP_LOGW(TAG, "Empty render response body");
            display_show_error("Error");
        }
    } else if (resp.status_code == 304) {
        ESP_LOGI(TAG, "Content unchanged — skipping display refresh");
        ok = true; if (render_ok) *render_ok = true;   /* legitimate no-change */
    } else if (resp.status_code == 204) {
        ESP_LOGI(TAG, "No content assigned — showing idle screen");
        display_show_no_content();
        ok = true; if (render_ok) *render_ok = true;   /* legitimate configured idle state */
    } else if (resp.status_code == 401) {
        ESP_LOGW(TAG, "401 Unauthorized");
        display_show_error("Unauthorized");
        nvs_manager_store_token("");
        http_client_set_token(NULL);
        perform_hello(NULL);
    } else if (resp.status_code >= 500 || resp.status_code == -1) {
        ESP_LOGW(TAG, "Server error (%d)", resp.status_code);
        display_show_error("Server Error");
    } else {
        ESP_LOGW(TAG, "Unexpected status %d", resp.status_code);
        display_show_error("Error");
    }

    http_client_free_response(&resp);
    return pace_retry(sleep_sec, ok);
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
    ESP_ERROR_CHECK(d1001_board_init());
    time_t rtc_time;
    if (d1001_rtc_get_time(&rtc_time) == ESP_OK) {
        struct timeval tv = { .tv_sec = rtc_time, .tv_usec = 0 };
        settimeofday(&tv, NULL);
        ESP_LOGI(TAG, "System clock restored from D1001 RTC");
    }
    d1001_backlight_on();
#else
    board_init();

    /* Immediate beep on button wake (before slow display init) */
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT1) {
        board_buzzer_beep(1000, 100);
    }
#endif
    display_init();
    /* Improv scan/provision commands may arrive as soon as the serial task is
     * visible to Web Serial. Initialize the shared Wi-Fi driver first so an
     * early request cannot race app_main's later station/SoftAP setup. */
    wifi_manager_init();
    vellum_serial_init();
#if defined(CONFIG_VELLUM_PANEL_D1001)
    xTaskCreate(d1001_button_task, "d1001_btn", 4096, NULL, 5, NULL);
#endif

    sleep_manager_init();
    wake_reason_t wake = sleep_manager_get_wake_reason();

    /* Only show boot screen on first power-on */
    if (wake == WAKE_REASON_POWER_ON) {
        display_show_boot(CONFIG_VELLUM_FIRMWARE_VERSION);
        board_buzzer_beep(1000, 100);
    }
    board_led_on();
#if !defined(CONFIG_VELLUM_PANEL_D1001)
    /* D1001 has one power button handled by d1001_button_task above. The
     * generic three-button map includes GPIO4/5, which are other board signals. */
    buttons_init();
#endif

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

    /* 0% is the DEEPEST discharge, not an "ignore me" sentinel — the old
     * `battery > 0` guard skipped exactly the most-critical case, letting the
     * device keep running WiFi + a full refresh on a near-dead cell and brown out
     * mid-write (corrupting NVS or a staged OTA slot → brick). Treat any stable
     * sub-critical reading as critical; boards with dedicated VBUS sense may
     * explicitly bypass this gate while externally powered. */
    if (battery < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT && !board_is_usb_powered()) {
        ESP_LOGW(TAG, "CRITICAL: Battery below %d%% — shutting down",
                 CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT);
        display_show_error("Low Battery");
        display_sleep_unless_usb_powered();
#if defined(CONFIG_VELLUM_PANEL_D1001)
        /* LCD mode returns after a bounded delay and re-checks the battery. */
        while (board_battery_level() < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT &&
               !board_is_usb_powered()) {
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        }
#else
        /* Never use permanent deep sleep here. A transient ADC under-read
         * would otherwise leave an otherwise healthy e-paper device appearing
         * dead until a manual reset. Timed sleep preserves brownout safety,
         * allows a fresh ADC sample, and permits button/USB wake for recovery. */
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
#endif
    }

    /* Prepare SNTP before DHCP so a network-provided NTP server (option 42)
     * is captured alongside the lease. */
    if (!time_sync_prepare()) {
        display_show_error("Time synchronization setup failed");
        display_sleep_unless_usb_powered();
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        esp_restart();
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
        ESP_LOGW(TAG, "Wi-Fi connection failed: %s",
                 wifi_manager_get_last_failure_message());
        uint32_t retry_after_seconds = CONFIG_VELLUM_FALLBACK_SLEEP_SEC;
#if defined(CONFIG_VELLUM_PANEL_D1001)
        /* LCD mode deliberately caps its retry wait at 30 seconds. Keep the
         * displayed estimate honest and leave the backlight on so the failure
         * screen remains visible throughout that short recovery window. */
        if (retry_after_seconds > 30) retry_after_seconds = 30;
#endif
        display_show_wifi_error(wifi_manager_get_last_failure_message(),
                                retry_after_seconds);
#if !defined(CONFIG_VELLUM_PANEL_D1001)
        display_sleep_unless_usb_powered();
#endif
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        /* On E-Paper: does not return. On D1001: returns, then restart to re-init WiFi */
        esp_restart();
    }

    /* A fresh boot has no trustworthy wall clock. Do not weaken certificate
     * verification or send device credentials until NTP has set the time. */
    if (!time_sync_wait_for_valid_clock()) {
        ESP_LOGW(TAG, "NTP did not provide a valid system time");
        display_show_error("Time synchronization failed\nCheck network access");
        display_sleep_unless_usb_powered();
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
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
            display_sleep_unless_usb_powered();
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            /* does not return */
        }
    }

    /* 6. Ensure we have a device token (TOFU) */
    char token[NVS_MAX_TOKEN_LEN];
    if (nvs_manager_get_token(token, sizeof(token)) == ESP_OK && strlen(token) > 0) {
        http_client_set_token(token);
    } else {
        vellum_http_failure_t hello_failure;
        while (!perform_hello(&hello_failure)) {
            ESP_LOGW(TAG, "No token after hello — device may be pending or server unreachable");
            if (hello_failure == VELLUM_HTTP_FAILURE_TLS_CERTIFICATE ||
                hello_failure == VELLUM_HTTP_FAILURE_TLS_HANDSHAKE) {
                display_transport_error(hello_failure);
            } else {
                display_show_error("No Server");
            }
            display_sleep_unless_usb_powered();
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            /* On D1001 this returns after delay; on E-Paper it does not return */
        }
    }

    /* 7. Request render and draw to display */
    bool render_ok = false;
    uint32_t sleep_duration = perform_render(&render_ok);

    /* Confirm a freshly-OTA'd image ONLY after a GENUINELY successful render
     * (WiFi + server + token + display all worked). Confirming after a failed
     * render would cancel the bootloader rollback for a broken-but-reachable
     * image, defeating A/B recovery. mark_valid is a no-op unless PENDING_VERIFY. */
    if (render_ok) ota_manager_mark_valid();

    /* 7b. If green button pressed during render, beep + re-render */
    while (buttons_key0_pressed()) {
        board_buzzer_beep(1000, 100);
        sleep_duration = perform_render(&render_ok);
        if (render_ok) ota_manager_mark_valid();
    }

    /* 8. Check for OTA update. A failed OTA briefly owns the display for clear
     * feedback, then we immediately restore the normal room view before sleep. */
    if (ota_manager_check_and_apply() == OTA_CHECK_RESTORE_RENDER) {
        sleep_duration = perform_render(&render_ok);
        if (render_ok) ota_manager_mark_valid();
    }
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
        sleep_duration = perform_render(&render_ok);
        /* A good image that failed its FIRST render still confirms on the first
         * successful poll here (mark_valid is idempotent). */
        if (render_ok) ota_manager_mark_valid();
        if (ota_manager_check_and_apply() == OTA_CHECK_RESTORE_RENDER) {
            sleep_duration = perform_render(&render_ok);
            if (render_ok) ota_manager_mark_valid();
        }
    }
#else
    /* 9. E-paper normally sleeps between refreshes. With external USB power
     * it deliberately remains awake and keeps polling, so a cabled display is
     * immediately reachable through its serial-provisioning interface. */
    while (board_is_usb_powered()) {
        ESP_LOGI(TAG, "External USB power present; refreshing in %lu seconds",
                 (unsigned long)sleep_duration);
        sleep_manager_enter(sleep_duration, buttons_get_wake_mask());
        if (!board_is_usb_powered()) break;
        if (sleep_manager_take_button_refresh_request()) {
            ESP_LOGI(TAG, "Green button confirmed — refreshing now");
        }
        sleep_duration = perform_render(&render_ok);
        if (render_ok) ota_manager_mark_valid();
        if (ota_manager_check_and_apply() == OTA_CHECK_RESTORE_RENDER) {
            sleep_duration = perform_render(&render_ok);
            if (render_ok) ota_manager_mark_valid();
        }
    }

    /* USB was not present (or was removed): return to low-power operation. */
    ESP_LOGI(TAG, "Sleeping for %lu seconds", (unsigned long)sleep_duration);
    display_sleep_unless_usb_powered();
    sleep_manager_enter(sleep_duration, buttons_get_wake_mask());
    /* does not return */
#endif
}
