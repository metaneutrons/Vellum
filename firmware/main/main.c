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
#include "esp_app_desc.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_netif_sntp.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "cJSON.h"
#include "mbedtls/base64.h"

#include "nvs_manager.h"
#include "vellum_log.h"
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
#include "security_posture.h"
#include "ota_manager.h"
#if defined(CONFIG_VELLUM_PANEL_D1001)
#include "d1001_board.h"
#include "vellum_audio.h"
#endif

/* The default time policy enables DHCP option 42 before association and falls
 * back to PTB when the lease supplies no server. Keeping this as a compile-time
 * invariant prevents a target-specific sdkconfig from turning that valid
 * runtime path into ESP_ERR_INVALID_ARG and a retry/reboot loop. */
#if !CONFIG_LWIP_DHCP_GET_NTP_SRV
#error "Vellum requires CONFIG_LWIP_DHCP_GET_NTP_SRV for its default NTP policy"
#endif

static const char *TAG = "vellum_main";

/* Boot-time NVS verdict, kept so the button paths can consult it. A display whose
 * storage is broken must stay recoverable by hand even where a factory reset is
 * otherwise refused. */
static bool s_nvs_unavailable;
static bool s_nvs_integrity_failed;

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
    char detail[NVS_MAX_URL_LEN + 40];
    display_server_url(safe_url, sizeof(safe_url));

    /* The URL belongs in the detail line, not crammed into the headline: it is
     * the longest and least urgent part, and at title size it forced the whole
     * screen down a font rung. */
    if (failure == VELLUM_HTTP_FAILURE_TLS_CERTIFICATE) {
        snprintf(detail, sizeof(detail), "Check server certificate\n%s", safe_url);
        display_show_status_message(VD_ICON_SERVER, "Secure connection failed", detail);
    } else if (failure == VELLUM_HTTP_FAILURE_TLS_HANDSHAKE) {
        snprintf(detail, sizeof(detail), "Check server TLS settings\n%s", safe_url);
        display_show_status_message(VD_ICON_SERVER, "Secure connection failed", detail);
    } else {
        display_show_status_message(VD_ICON_SERVER, "Server unavailable", safe_url);
    }
}

static vellum_telemetry_t gather_telemetry(void)
{
    static char wifi_ssid_b64[48];
    static vellum_security_posture_t security_posture;
    static bool security_posture_collected;
    if (!security_posture_collected) {
        security_posture_collected = true;
        const esp_err_t posture_err = security_posture_collect(&security_posture);
        if (posture_err != ESP_OK) {
            ESP_LOGE(TAG, "Security posture collection failed: %s", esp_err_to_name(posture_err));
            security_posture.chip_model = "unknown";
            security_posture.partition_layout = "unknown";
        }
    }
    /* Read the cell first: on D1001 this also applies the charger's safe
     * hysteresis, so the state reported below describes the resulting state. */
    const float battery_voltage = board_battery_voltage();
    const int battery_level = board_battery_level();
    const bool usb_powered = board_is_usb_powered();
    const board_battery_status_t battery_status = board_battery_status();
    /* E1002 hardware revision 1.0 uses an ETA6003 without an MCU-readable
     * power-source signal; revision 1.2 replaced it with the I2C SY6974B.
     * A failed charger read must therefore remain unknown, never be presented
     * as positive evidence that the device is running on battery. */
    const char *power_source = usb_powered
        ? "usb"
        : (battery_status == BOARD_BATTERY_STATUS_UNKNOWN ? "unknown" : "battery");
    const esp_app_desc_t *app = esp_app_get_description();
    const char *firmware_version =
        (app && app->version[0]) ? app->version : CONFIG_VELLUM_FIRMWARE_VERSION;
    char wifi_ssid[NVS_MAX_SSID_LEN] = {0};
    size_t wifi_ssid_b64_len = 0;
    wifi_ssid_b64[0] = '\0';
    if (wifi_manager_get_current_ssid(wifi_ssid, sizeof(wifi_ssid)) == ESP_OK &&
        mbedtls_base64_encode((unsigned char *)wifi_ssid_b64, sizeof(wifi_ssid_b64) - 1,
                              &wifi_ssid_b64_len, (const unsigned char *)wifi_ssid,
                              strlen(wifi_ssid)) == 0) {
        wifi_ssid_b64[wifi_ssid_b64_len] = '\0';
    }
    vellum_telemetry_t t = {
        .battery_voltage = battery_voltage,
        .battery_level   = battery_level,
        .power_source    = power_source,
        .battery_status  = board_battery_status_name(battery_status),
        .wifi_rssi       = wifi_manager_get_rssi(),
        .wifi_ssid_b64   = wifi_ssid_b64[0] ? wifi_ssid_b64 : NULL,
        .wifi_security   = wifi_manager_get_current_security(),
        .firmware_ver    = firmware_version,
        .security_profile = CONFIG_VELLUM_SECURITY_PROFILE,
        .nvs_integrity   = nvs_manager_integrity_status_name(),
        .chip_model = security_posture.chip_model,
        .chip_revision = security_posture.chip_revision,
        .flash_size_bytes = security_posture.flash_size_bytes,
        .partition_layout = security_posture.partition_layout,
        .partition_fingerprint = security_posture.partition_fingerprint[0]
            ? security_posture.partition_fingerprint : NULL,
        .partition_table_offset = security_posture.partition_table_offset,
        .layout_verified = security_posture.layout_verified,
        .secure_boot_enabled = security_posture.secure_boot_enabled,
        .flash_encryption_enabled = security_posture.flash_encryption_enabled,
        .nvs_encryption_enabled = security_posture.nvs_encryption_enabled,
    };
    return t;
}

static void refresh_telemetry(void)
{
    /* D1001 stays awake and reuses the HTTP client for its entire polling
     * lifetime. Refresh the snapshot for every cycle so unplugging USB, charge
     * state changes and battery discharge are not reported with boot-time
     * values forever. The board driver caches ADC samples for 250 ms, keeping
     * the several requests within one cycle consistent without stale data
     * leaking into the next cycle. */
    vellum_telemetry_t telemetry = gather_telemetry();
    http_client_set_telemetry(&telemetry);
}

/* -----------------------------------------------------------------------
 * TOFU hello handshake
 * ----------------------------------------------------------------------- */

/**
 * @param pending  Set true when the server answered normally and said this
 *                 device is awaiting operator approval. Without this, the caller
 *                 cannot tell a correctly-enrolled device from an unreachable
 *                 server, and showed a red "No Server" fault for both.
 */
static bool perform_hello(vellum_http_failure_t *failure, bool *pending)
{
    if (failure) *failure = VELLUM_HTTP_FAILURE_NONE;
    if (pending) *pending = false;
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
                    if (pending) *pending = true;
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

/* Retry ladder from the assigned refresh profile (X-Error-Backoff). Also in RTC
 * memory: the streak is useless without the ladder that goes with it, and a cold
 * boot into an unreachable server never receives a header at all — hence the
 * built-in default below, which mirrors errorBackoffS in src/lib/sleep. */
RTC_DATA_ATTR static uint32_t s_backoff_ladder[RENDER_BACKOFF_MAX_STEPS];
RTC_DATA_ATTR static uint32_t s_backoff_steps;

static const uint32_t k_default_backoff[] = { 60, 300, 900, 3600 };

/* How often a device that is enrolled but not yet approved checks back. Short
 * enough that approving a display in the admin UI visibly wakes it, long enough
 * not to burn a battery in the approval queue. Deliberately NOT the backoff
 * ladder — see the 401 branch in perform_render(). */
#define VELLUM_APPROVAL_POLL_SEC 300

/* Adopt a ladder the server just sent. Ignored when the header is absent so a
 * 304 or an error response never silently clears a good ladder. */
static void adopt_backoff_ladder(const char *header)
{
    uint32_t parsed[RENDER_BACKOFF_MAX_STEPS];
    size_t n = render_backoff_parse(header, parsed, RENDER_BACKOFF_MAX_STEPS);
    if (n == 0) return;
    for (size_t i = 0; i < n; i++) s_backoff_ladder[i] = parsed[i];
    s_backoff_steps = (uint32_t)n;
}

/* Pace retries: a healthy cycle keeps the server's cadence, a failing one walks
 * the ladder — which starts BELOW the cadence, so one dropped request costs a
 * minute rather than the doubled cadence this used to impose. */
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

    const uint32_t *ladder = s_backoff_steps > 0 ? s_backoff_ladder : k_default_backoff;
    size_t steps = s_backoff_steps > 0 ? s_backoff_steps
                                       : sizeof(k_default_backoff) / sizeof(k_default_backoff[0]);

    uint32_t delay = render_backoff_delay(base_sec, s_render_failures, ladder, steps);
#if CONFIG_VELLUM_ERROR_BACKOFF_MAX_SEC > 0
    if (delay > CONFIG_VELLUM_ERROR_BACKOFF_MAX_SEC) {
        delay = CONFIG_VELLUM_ERROR_BACKOFF_MAX_SEC;
    }
#endif
    if (delay != base_sec) {
        ESP_LOGW(TAG, "Backing off after %lu consecutive failure(s): %lu s instead of %lu s",
                 (unsigned long)s_render_failures, (unsigned long)delay,
                 (unsigned long)base_sec);
    }
    return delay;
}

/*
 * Ship retained diagnostics once per cycle, after the poll has proved the server
 * reachable. Bytes are dropped only on a 2xx, so a server that does not know the
 * endpoint yet, or one that is unreachable, costs a retry rather than the
 * evidence.
 */
static void upload_pending_logs(void)
{
    static char batch[4096];
    uint32_t seq = 0;
    const size_t len = vellum_log_take_upload(batch, sizeof(batch), &seq);
    if (len == 0) return;
    vellum_log_suspend_trigger(true);
    const esp_err_t err = http_client_post_logs(seq, batch, len);
    vellum_log_suspend_trigger(false);
    if (err == ESP_OK) vellum_log_upload_confirmed(seq);
}

static uint32_t perform_render(bool *render_ok)
{
    bool ok = false;
    if (render_ok) *render_ok = false;
    refresh_telemetry();
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
    adopt_backoff_ladder(resp.error_backoff);

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
            /* Name the cause. All three used to surface as one "Image rejected"
             * screen with no log line, and a display that could not reserve its
             * decode buffer looked exactly like a server sending a bad frame. */
            const esp_err_t draw = display_update_raw(resp.binary_body, resp.binary_len);
            if (draw != ESP_OK) {
                ESP_LOGW(TAG, "Frame not drawn: %s (%zu bytes)", esp_err_to_name(draw),
                         resp.binary_len);
                if (draw == ESP_ERR_NO_MEM) {
                    display_show_status_message(VD_ICON_WARNING, "Out of memory",
                                                "The display could not reserve memory "
                                                "to draw this frame");
                } else if (draw == ESP_ERR_INVALID_STATE) {
                    display_show_status_message(VD_ICON_WARNING, "Display not ready",
                                                "The panel was not initialized when "
                                                "the frame arrived");
                } else {
                    display_show_status_message(VD_ICON_WARNING, "Image rejected",
                                                "The server sent a frame this panel "
                                                "could not draw");
                }
            } else {
                ok = true;           /* frame drawn successfully */
                http_client_commit_render_etag(resp.etag);
                if (render_ok) *render_ok = true;
            }
        } else {
            ESP_LOGW(TAG, "Empty render response body");
            display_show_status_message(VD_ICON_SERVER, "Empty response",
                                        "The server returned no image");
        }
    } else if (resp.status_code == 304) {
        ESP_LOGI(TAG, "Content unchanged — skipping display refresh");
        ok = true; if (render_ok) *render_ok = true;   /* legitimate no-change */
    } else if (resp.status_code == 204) {
        ESP_LOGI(TAG, "No content assigned — showing idle screen");
        display_show_no_content();
        http_client_commit_render_etag(resp.etag);
        ok = true; if (render_ok) *render_ok = true;   /* legitimate configured idle state */
    } else if (resp.status_code == 401) {
        /* Not a fault the operator can fix at the device: the stored token was
         * revoked, and the very next thing this branch does is re-enrol. The old
         * red "Unauthorized" made a normal re-enrolment look like a failure. */
        ESP_LOGW(TAG, "401 Unauthorized");
        nvs_manager_store_token("");
        http_client_set_token(NULL);
        bool pending = false;
        bool re_enrolled = perform_hello(NULL, &pending);
        if (pending) {
            display_show_status_message(VD_ICON_PENDING, "Waiting for approval",
                                        "An administrator must approve this "
                                        "display");
        } else if (re_enrolled) {
            display_show_status_message(VD_ICON_REFRESH, "Reconnected",
                                        "Fetching content");
        } else {
            display_show_status_message(VD_ICON_PENDING, "Reconnecting",
                                        "The server no longer accepts this "
                                        "display's token");
        }

        /* Neither waiting for approval nor having just re-enrolled is a failure,
         * so neither may enter the backoff ladder: a display sitting in the
         * approval queue used to drift out to the ladder's last rung, so after an
         * operator finally approved it, it could stay blank for another hour.
         * Fixed brisk cadence, streak reset. */
        if (pending || re_enrolled) {
            s_render_failures = 0;
            http_client_free_response(&resp);
            return VELLUM_APPROVAL_POLL_SEC;
        }
    } else if (resp.status_code >= 500 || resp.status_code == -1) {
        ESP_LOGW(TAG, "Server error (%d)", resp.status_code);
        display_show_status_message(VD_ICON_SERVER, "Server error",
                                    "Retrying automatically");
    } else {
        char detail[48];
        ESP_LOGW(TAG, "Unexpected status %d", resp.status_code);
        snprintf(detail, sizeof(detail), "Unexpected response (HTTP %d)",
                 resp.status_code);
        display_show_status_message(VD_ICON_SERVER, "Server error", detail);
    }

    http_client_free_response(&resp);
    return pace_retry(sleep_sec, ok);
}

/**
 * May a button erase this display's configuration?
 *
 * Re-provisioning an enrolled display over USB already demands a server-signed
 * admin authorization (see vellum_serial's challenge/HMAC exchange). A button
 * held for a few seconds needed nothing at all, which made the physical path the
 * weakest one and let anybody who could reach a panel in a public room wipe its
 * Wi-Fi credentials, device token and keypair. The lock's own comment conceded
 * as much: it holds "until a physical factory reset erases the namespace".
 *
 * Broken storage is the deliberate exception, and it is not a loophole. When NVS
 * cannot be opened or fails its integrity check there is nothing readable left to
 * protect, the enrollment lock reports locked because it fails closed, and the
 * firmware already puts "Storage recovery required — Factory reset and re-enroll"
 * on the screen. Refusing here would make that instruction impossible to follow
 * and turn every corrupted display into a workshop case.
 *
 * Returns false and sets *reason to a short line for the panel when refused.
 */
static bool factory_reset_permitted(const char **reason)
{
    if (s_nvs_unavailable || s_nvs_integrity_failed) return true; /* recovery */

#if !CONFIG_VELLUM_BUTTON_FACTORY_RESET
    *reason = "Disabled on this firmware";
    return false;
#else
    if (nvs_manager_is_provisioning_locked()) {
        *reason = "Enrolled display \u2014 authorize in Vellum";
        return false;
    }
    return true;
#endif
}

/** Refuse visibly: a dead button teaches nothing. */
static void factory_reset_refused(const char *reason)
{
    ESP_LOGW(TAG, "Factory reset refused: %s", reason);
    display_show_status_message(VD_ICON_SERVER, "Factory reset not allowed", reason);
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

    case BUTTON_ACTION_FACTORY_RESET: {
        const char *reason = NULL;
        if (!factory_reset_permitted(&reason)) {
            factory_reset_refused(reason);
            return true;
        }
        ESP_LOGW(TAG, "Factory reset — erasing NVS");
        board_buzzer_beep(500, 500);
        /* This recovery path must work even when the NVS namespace cannot be
         * opened (format/version error or failed integrity initialization). */
        nvs_flash_erase();
        esp_restart();
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

#ifdef CONFIG_VELLUM_BUTTON_ACTIVE_HIGH
  #define PRESSED_LEVEL 1
#else
  #define PRESSED_LEVEL 0
#endif

volatile bool s_button_pressed = false;

/* -----------------------------------------------------------------------
 * Stall supervisor
 *
 * The poll loop below can stop making progress without crashing: a D1001 on
 * 1.5.0 went silent for hours while its button task still chimed and set
 * s_button_pressed, because nothing was left running to read that flag. Nothing
 * recovered it, because nothing in this firmware subscribes to the ESP-IDF task
 * watchdog.
 *
 * Subscribing the main task to that watchdog is not the fix. Its timeout is
 * global (CONFIG_ESP_TASK_WDT_TIMEOUT_S, 30 s) and one cycle can legitimately
 * exceed it, since a single HTTP request may take CONFIG_VELLUM_HTTP_TIMEOUT_MS
 * and an OTA download takes minutes. It would reboot mid-update.
 *
 * So progress is reported explicitly and judged against a generous deadline,
 * widened around operations known to be slow. Detecting a stall in minutes is
 * the goal; anything is better than never.
 * ----------------------------------------------------------------------- */

/* Kconfig hides the grace window when the supervisor is switched off, so the
 * call sites below still need a value to compile against. */
#ifndef CONFIG_VELLUM_OTA_GRACE_S
#define CONFIG_VELLUM_OTA_GRACE_S 0
#endif
#ifndef CONFIG_VELLUM_BOOT_GRACE_S
#define CONFIG_VELLUM_BOOT_GRACE_S 0
#endif

static volatile int64_t s_progress_us;   /* last time the loop reported progress */
static volatile uint32_t s_grace_s;      /* extra allowance for a slow operation */
static volatile bool s_stall_disarmed;   /* set where waiting forever is correct */

/** Report that the poll loop is still advancing. */
static void app_progress(void)
{
    s_progress_us = esp_timer_get_time();
}

/** Widen the deadline while a known-slow operation runs; 0 restores the default. */
static void app_progress_grace(uint32_t seconds)
{
    s_grace_s = seconds;
    app_progress();
}

/**
 * Give up watching, permanently, because waiting forever is the correct
 * behaviour here.
 *
 * Some states are deliberately unbounded: a display in SoftAP is holding a
 * captive portal open until somebody provisions it, and one on a critical cell
 * is waiting for power. Rebooting either on a timer would be worse than the
 * stall this supervisor exists to catch — it would tear down the provisioning
 * portal every few minutes and make setup nearly impossible. There is no
 * re-arm: every one of these paths ends in a restart anyway.
 */
static void app_stall_disarm(void)
{
    s_stall_disarmed = true;
}

#if CONFIG_VELLUM_STALL_TIMEOUT_S > 0
static void stall_supervisor_task(void *arg)
{
    (void)arg;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        if (s_stall_disarmed) continue;
        int64_t idle_s = (esp_timer_get_time() - s_progress_us) / 1000000;
        uint32_t deadline_s = CONFIG_VELLUM_STALL_TIMEOUT_S + s_grace_s;
        if (idle_s >= (int64_t)deadline_s) {
            /* Logged before restarting so a cabled console shows the reason; the
             * reboot itself is the recovery, and an unconfirmed image will be
             * rolled back by the anti-brick check rather than looping forever. */
            ESP_LOGE(TAG, "Poll loop stalled for %llds (limit %lus) — restarting",
                     (long long)idle_s, (unsigned long)deadline_s);
            vTaskDelay(pdMS_TO_TICKS(100)); /* let the log drain */
            esp_restart();
        }
    }
}
#endif

static void stall_supervisor_start(void)
{
    static bool started;
    if (started) return;
    started = true;
    app_progress();
#if CONFIG_VELLUM_STALL_TIMEOUT_S > 0
    xTaskCreate(stall_supervisor_task, "vellum_stall", 3072, NULL, 5, NULL);
    ESP_LOGI(TAG, "Stall supervisor armed (%ds)", CONFIG_VELLUM_STALL_TIMEOUT_S);
#else
    ESP_LOGW(TAG, "Stall supervisor disabled — a wedged poll loop will not recover");
#endif
}

#if defined(CONFIG_VELLUM_PANEL_D1001)
/* D1001 has a single wired key (KEY0), so it cannot copy the E-Series two-key
 * factory-reset grip. Its scale used to be refresh under 5 s, reboot from 5 to
 * 10 s and erase at 10 s: one continuous press, with the destructive step one
 * second past a routine one. Holding a fraction too long wiped the display, and
 * that is how one lost its Wi-Fi credentials during this investigation.
 *
 * The ranges no longer touch, and the erase is no longer part of the same
 * gesture. A long hold only ASKS; releasing does nothing. Confirming needs a
 * second, separate press inside a short window, which an accidental grip does
 * not produce. */
#define D1001_REBOOT_HOLD_MS   2000
#define D1001_RESET_ASK_MS     5000
#define D1001_CONFIRM_WINDOW_MS 5000

static void d1001_button_task(void *arg)
{
    (void)arg;
    gpio_num_t btn = (gpio_num_t)CONFIG_VELLUM_BUTTON_KEY0_GPIO;
    /* Wait for button release after boot */
    while (gpio_get_level(btn) == PRESSED_LEVEL) vTaskDelay(pdMS_TO_TICKS(50));
    vTaskDelay(pdMS_TO_TICKS(500));

    /* Set by a hold that reached the ask; cleared when the window closes. */
    int64_t confirm_until_us = 0;

    while (1) {
        if (gpio_get_level(btn) == PRESSED_LEVEL) {
            int64_t start_us = esp_timer_get_time();
            bool asked = false;
            while (gpio_get_level(btn) == PRESSED_LEVEL) {
                int64_t held_ms = (esp_timer_get_time() - start_us) / 1000;
                if (!asked && held_ms >= D1001_RESET_ASK_MS) {
                    asked = true;
                    const char *reason = NULL;
                    if (factory_reset_permitted(&reason)) {
                        display_show_status_message(
                            VD_ICON_REFRESH, "Factory reset?",
                            "Release, then press again to confirm");
                    } else {
                        /* Say no while the finger is still down, rather than
                         * letting the operator complete a gesture that cannot
                         * work. */
                        factory_reset_refused(reason);
                    }
                }
                vTaskDelay(pdMS_TO_TICKS(50));
            }
            int64_t held_ms = (esp_timer_get_time() - start_us) / 1000;

            if (held_ms >= D1001_RESET_ASK_MS) {
                const char *reason = NULL;
                /* Arm the window only if it could actually be honoured. */
                confirm_until_us = factory_reset_permitted(&reason)
                                       ? esp_timer_get_time() +
                                             (int64_t)D1001_CONFIRM_WINDOW_MS * 1000
                                       : 0;
            } else if (confirm_until_us && esp_timer_get_time() < confirm_until_us) {
                /* The second press. Length does not matter here: reaching the ask
                 * was the deliberate part, this is the confirmation. */
                confirm_until_us = 0;
                const char *reason = NULL;
                if (factory_reset_permitted(&reason)) {
                    display_show_status_message(VD_ICON_REFRESH, "Factory reset",
                                                "Erasing configuration");
                    vTaskDelay(pdMS_TO_TICKS(500));
                    nvs_flash_erase();
                    esp_restart();
                } else {
                    factory_reset_refused(reason);
                }
            } else if (held_ms >= D1001_REBOOT_HOLD_MS) {
                esp_restart();
            } else {
                /* Short press: refresh. D1001 has an ES8311 speaker instead of the
                 * E-Series PWM buzzer, so board_buzzer_beep() maps to its
                 * confirmation chime; acknowledge before the render work begins. */
                board_buzzer_beep(1000, 100);
                s_button_pressed = true;
            }
        }
        if (confirm_until_us && esp_timer_get_time() >= confirm_until_us) {
            confirm_until_us = 0;
            ESP_LOGI(TAG, "Factory reset not confirmed — window closed");
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
#endif

void app_main(void)
{
    /* First, so the banner and every later line are retained. A display that
     * wedges or refuses its frames has to be diagnosable without a cable
     * attached at the exact moment it happens. */
    vellum_log_init();

    const esp_app_desc_t *app = esp_app_get_description();
    const char *firmware_version =
        (app && app->version[0]) ? app->version : CONFIG_VELLUM_FIRMWARE_VERSION;
    ESP_LOGI(TAG, "===== Vellum Firmware v%s =====", firmware_version);

    /* Recorded through the hook, so it reaches the server with the rest. */
    {
        char carried[1024];
        if (vellum_log_previous_boot(carried, sizeof(carried)) > 0) {
            ESP_LOGW(TAG, "Carried over from the previous boot:\n%s", carried);
        }
    }

    /* 1. Initialize core subsystems */
    esp_err_t nvs_init_err = nvs_manager_init();
    bool nvs_integrity_failed = nvs_init_err == ESP_ERR_INVALID_CRC;
    bool nvs_unavailable = nvs_init_err != ESP_OK;
    s_nvs_integrity_failed = nvs_integrity_failed;
    s_nvs_unavailable = nvs_unavailable;
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
    /* Initialize audio before the button task can request playback. Audio is
     * optional; a missing codec must never prevent the room display from booting. */
    esp_err_t audio_err = vellum_audio_init();
    if (audio_err != ESP_OK) {
        ESP_LOGW(TAG, "D1001 audio unavailable: %s", esp_err_to_name(audio_err));
    }
#else
    board_init();

    /* No sound on waking, deliberately. Audio is reserved for two things: a
     * failure the room needs to notice, and acknowledging a button someone just
     * pressed. A wake is neither. It also cannot be trusted as a press: EXT1 is
     * armed level-triggered on a pin whose only pull-up is internal, so an
     * unattended wake reports the same cause a finger does.
     *
     * A genuine button wake is therefore silent too. The acknowledgement now
     * belongs to the paths that observe the press while the device is running
     * (buttons_key0_pressed() below, and the USB-powered wait in
     * sleep_manager_enter()), not to a wake reason. */
#endif
    display_init();
    /* Improv scan/provision commands may arrive as soon as the serial task is
     * visible to Web Serial. Initialize the shared Wi-Fi driver first so an
     * early request cannot race app_main's later station/SoftAP setup. */
    wifi_manager_init();
    vellum_serial_init();
#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* 8 KiB, not 4: this task draws. Showing the factory-reset prompt or a
     * refusal calls into the display and LVGL, which overflowed a 4 KiB stack and
     * panicked with "Stack protection fault" — read from the outside as the
     * display simply rebooting after a long press. */
    xTaskCreate(d1001_button_task, "d1001_btn", 8192, NULL, 5, NULL);
#endif

    sleep_manager_init();
    wake_reason_t wake = sleep_manager_get_wake_reason();

    /* Only show the boot screen on first power-on. Autonomous wake cycles must
     * stay silent: some boards may be power-cycled between polls and report
     * those starts as POWER_ON rather than a timer wake. Audible feedback is
     * reserved for deliberate button actions and important OTA events. */
    if (wake == WAKE_REASON_POWER_ON) {
        display_show_boot(firmware_version);
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
                snprintf(msg, sizeof(msg), "Factory reset in %d", rem);
                display_show_status_message(VD_ICON_REFRESH, msg,
                                            "Release the button to cancel");
            }
            vTaskDelay(pdMS_TO_TICKS(200));
            held_ms += 200;
        }
        if (held_ms >= 10000) {
            /* Same policy as the runtime paths. Held at power-on this gesture is
             * already deliberate, so it needs no second press, but an enrolled or
             * production display must still refuse it. */
            const char *reason = NULL;
            if (!factory_reset_permitted(&reason)) {
                factory_reset_refused(reason);
                vTaskDelay(pdMS_TO_TICKS(3000));
                esp_restart();
            }
            display_show_status_message(VD_ICON_REFRESH, "Factory reset",
                                        "Erasing configuration");
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

    if (nvs_unavailable) {
        ESP_LOGE(TAG, "Configuration unavailable (%s); networking is blocked",
                 esp_err_to_name(nvs_init_err));
        display_show_status_message(
            VD_ICON_WARNING, "Configuration protected",
            nvs_integrity_failed
                ? "Integrity check failed\nFactory reset and re-enroll"
                : "Storage recovery required\nFactory reset and re-enroll");
        while (true) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    ESP_LOGI(TAG, "Wake reason: %s",
             wake == WAKE_REASON_TIMER  ? "TIMER" :
             wake == WAKE_REASON_BUTTON ? "BUTTON" : "POWER_ON");

    /* Watch the boot path too, not just the steady-state loop.
     *
     * The first version armed this immediately before the poll loop, which left
     * everything above it unguarded — and there is a lot above it: Wi-Fi
     * association with retries, up to 50 s of NTP waiting, enrolment and the
     * first render, each with its own 30 s HTTP timeout. A display that wedges
     * there never reaches the loop, so nothing was watching precisely while the
     * riskiest calls ran.
     *
     * Boot legitimately takes far longer than a poll cycle, hence its own
     * grace; the loop drops back to the ordinary deadline once it starts. Paths
     * that wait forever on purpose disarm the supervisor outright rather than
     * stretching this number to cover them. */
    stall_supervisor_start();
    app_progress_grace(CONFIG_VELLUM_BOOT_GRACE_S);

    /* 2. Check battery — critical shutdown if below threshold */
    int battery = board_battery_level();
    if (battery >= 0) {
        ESP_LOGI(TAG, "Battery level: %d%%", battery);
    } else {
        ESP_LOGW(TAG, "Battery level unavailable; continuing without low-battery gate");
    }

    /* 0% is the DEEPEST discharge, not an "ignore me" sentinel — the old
     * `battery > 0` guard skipped exactly the most-critical case, letting the
     * device keep running WiFi + a full refresh on a near-dead cell and brown out
     * mid-write (corrupting NVS or a staged OTA slot → brick). Treat any stable
     * sub-critical reading as critical; boards with dedicated VBUS sense may
     * explicitly bypass this gate while externally powered. */
    if (battery >= 0 && battery < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT &&
        !board_is_usb_powered()) {
        ESP_LOGW(TAG, "CRITICAL: Battery below %d%% — shutting down",
                 CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT);
        display_show_status_message(VD_ICON_BATTERY, "Low battery",
                                    "Connect USB power to continue");
        display_sleep_unless_usb_powered();
#if defined(CONFIG_VELLUM_PANEL_D1001)
        /* LCD mode returns after a bounded delay and re-checks the battery. */
        /* Waiting for someone to plug the display in is not a stall. */
        app_stall_disarm();
        int retry_battery = board_battery_level();
        while (retry_battery >= 0 &&
               retry_battery < CONFIG_VELLUM_BATTERY_CRITICAL_PERCENT &&
               !board_is_usb_powered()) {
            sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
            retry_battery = board_battery_level();
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
        display_show_status_message(VD_ICON_WARNING, "Clock unavailable",
                                    "Time synchronization could not start");
        display_sleep_unless_usb_powered();
        sleep_manager_enter(CONFIG_VELLUM_FALLBACK_SLEEP_SEC, buttons_get_wake_mask());
        esp_restart();
    }

    /* 3. Connect to Wi-Fi or enter SoftAP */
    wifi_result_t wifi_result = wifi_manager_connect_station();
    app_progress();

    if (wifi_result == WIFI_RESULT_NO_CREDENTIALS) {
        ESP_LOGI(TAG, "No Wi-Fi credentials — entering SoftAP");
        char ssid[32];
        wifi_manager_get_softap_ssid(ssid, sizeof(ssid));
        char qr_payload[64];
        snprintf(qr_payload, sizeof(qr_payload), "WIFI:T:nopass;S:%s;;", ssid);
        display_show_wifi_setup(ssid, qr_payload);
        /* Holding a captive portal open is the job here, for as long as it takes
         * somebody to walk over and provision the display. Rebooting on a timer
         * would drop the portal mid-setup. */
        app_stall_disarm();
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
        display_show_status_message(VD_ICON_WIFI, "Clock not set",
                                    "Check network access to the time server");
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

    refresh_telemetry();

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
        bool hello_pending = false;
        while (!perform_hello(&hello_failure, &hello_pending)) {
            ESP_LOGW(TAG, "No token after hello — device may be pending or server unreachable");
            if (hello_pending) {
                /* The server answered and enrolled this device; it is simply not
                 * approved yet. This is the single most common state a new
                 * display sits in, and it used to render as a red "No Server". */
                display_show_status_message(VD_ICON_PENDING, "Waiting for approval",
                                            "An administrator must approve this "
                                            "display in Vellum");
            } else if (hello_failure == VELLUM_HTTP_FAILURE_TLS_CERTIFICATE ||
                       hello_failure == VELLUM_HTTP_FAILURE_TLS_HANDSHAKE) {
                display_transport_error(hello_failure);
            } else {
                char safe_url[NVS_MAX_URL_LEN];
                display_server_url(safe_url, sizeof(safe_url));
                display_show_status_message(VD_ICON_SERVER, "No server", safe_url);
            }
            display_sleep_unless_usb_powered();
            /* Approval is the state an operator is actively waiting on, so poll
             * briskly for it rather than at the 15-minute fallback cadence. */
            sleep_manager_enter(hello_pending ? VELLUM_APPROVAL_POLL_SEC
                                              : CONFIG_VELLUM_FALLBACK_SLEEP_SEC,
                                buttons_get_wake_mask());
            /* On D1001 this returns after delay; on E-Paper it does not return */
        }
    }

    /* A power loss during an authenticated Wi-Fi rotation rolls back in NVS
     * before networking. Report that durable outcome once the token is ready. */
    ota_manager_report_deferred_configuration();

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
    upload_pending_logs();
    if (ota_manager_check_and_apply() == OTA_CHECK_RESTORE_RENDER) {
        sleep_duration = perform_render(&render_ok);
        if (render_ok) ota_manager_mark_valid();
    }
    board_led_off();

#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* LCD: poll loop instead of deep sleep */
    ESP_LOGI(TAG, "Polling every %lu seconds", (unsigned long)sleep_duration);
    app_progress_grace(0); /* boot is over — back to the ordinary deadline */
    while (1) {
        for (uint32_t i = 0; i < sleep_duration && !s_button_pressed; i++) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            app_progress(); /* idling on purpose is progress; being stuck here is not */
        }
        if (s_button_pressed) {
            s_button_pressed = false;
            ESP_LOGI(TAG, "Button → immediate refresh");
        }
        sleep_duration = perform_render(&render_ok);
        app_progress();
        /* A good image that failed its FIRST render still confirms on the first
         * successful poll here (mark_valid is idempotent). */
        if (render_ok) ota_manager_mark_valid();
        /* An OTA download runs inside this call for minutes at a time. */
        app_progress_grace(CONFIG_VELLUM_OTA_GRACE_S);
        ota_check_result_t ota = ota_manager_check_and_apply();
        app_progress_grace(0);
        upload_pending_logs();
        if (ota == OTA_CHECK_RESTORE_RENDER) {
            sleep_duration = perform_render(&render_ok);
            app_progress();
            if (render_ok) ota_manager_mark_valid();
        }
    }
#else
    /* 9. E-paper normally sleeps between refreshes. With external USB power
     * it deliberately remains awake and keeps polling, so a cabled display is
     * immediately reachable through its serial-provisioning interface. */
    /* The battery path below deep sleeps, which resets the SoC on wake, so a
     * stall there cannot outlive the sleep timer. */
    app_progress_grace(0); /* boot is over — back to the ordinary deadline */
    while (board_is_usb_powered()) {
        ESP_LOGI(TAG, "External USB power present; refreshing in %lu seconds",
                 (unsigned long)sleep_duration);
        sleep_manager_enter(sleep_duration, buttons_get_wake_mask());
        app_progress();
        if (!board_is_usb_powered()) break;
        if (sleep_manager_take_button_refresh_request()) {
            ESP_LOGI(TAG, "Green button confirmed — refreshing now");
        }
        sleep_duration = perform_render(&render_ok);
        app_progress();
        if (render_ok) ota_manager_mark_valid();
        app_progress_grace(CONFIG_VELLUM_OTA_GRACE_S);
        ota_check_result_t ota = ota_manager_check_and_apply();
        app_progress_grace(0);
        upload_pending_logs();
        if (ota == OTA_CHECK_RESTORE_RENDER) {
            sleep_duration = perform_render(&render_ok);
            app_progress();
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
