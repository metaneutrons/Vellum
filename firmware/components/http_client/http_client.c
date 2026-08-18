// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file http_client.c
 * @brief ESP-IDF HTTP client implementation for Vellum backend.
 */

#include "http_client.h"
#include "vellum_display.h"
#include "nvs_manager.h"
#include "response_headers.h"
#include "transport_policy.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"

static const char *TAG = "http_cli";

/** Maximum response body size to prevent OOM on malicious responses.
 *  2 MB ceiling — the largest panel (E1003) needs ~1.3 MB for a 4bpp frame. */
#define MAX_RESPONSE_SIZE (2 * 1024 * 1024)

static char s_base_url[NVS_MAX_URL_LEN];
static char s_mac[13];
static char s_token[NVS_MAX_TOKEN_LEN];
static char s_public_key[64]; /* base64-encoded X25519 public key (44 chars + null) */
static char s_last_etag[32] = {0};
static void load_etag(void);
static void save_etag(const char *etag);
static vellum_telemetry_t s_telemetry = {0};

/* Release builds only allow HTTPS. A deliberately local development build may
 * additionally allow HTTP to an RFC1918 IPv4 literal; OTA remains HTTPS-only. */
static bool s_base_url_transport_allowed = false;

/* ---- internal helpers -------------------------------------------------- */

/**
 * Event handler that accumulates response body into a dynamically
 * growing buffer attached to the user_data pointer.
 */
typedef struct {
    char   *buf;
    size_t  len;
    size_t  cap;
    /* Set only after the TCP transport is established.  A subsequent HTTPS
     * failure with no HTTP response is a TLS handshake failure even when the
     * ESP-IDF error tracker has no mbedTLS code (for example, peer close). */
    bool    transport_connected;
    vellum_response_headers_t headers;
} resp_buf_t;

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    resp_buf_t *rb = (resp_buf_t *)evt->user_data;
    if (!rb) return ESP_OK;

    switch (evt->event_id) {
    case HTTP_EVENT_ON_CONNECTED:
        rb->transport_connected = true;
        break;
    case HTTP_EVENT_ON_HEADER:
        vellum_response_headers_capture(&rb->headers, evt->header_key, evt->header_value);
        break;
    case HTTP_EVENT_ON_DATA:
        if (evt->data_len > 0) {
            /* Enforce response size limit */
            if (rb->len + evt->data_len > MAX_RESPONSE_SIZE) {
                ESP_LOGE(TAG, "Response exceeds %d byte limit", MAX_RESPONSE_SIZE);
                return ESP_ERR_NO_MEM;
            }
            size_t needed = rb->len + evt->data_len + 1;
            if (needed > rb->cap) {
                size_t new_cap = needed * 2;
                char *tmp = realloc(rb->buf, new_cap);
                if (!tmp) {
                    ESP_LOGE(TAG, "OOM growing response buffer");
                    return ESP_ERR_NO_MEM;
                }
                rb->buf = tmp;
                rb->cap = new_cap;
            }
            memcpy(rb->buf + rb->len, evt->data, evt->data_len);
            rb->len += evt->data_len;
            rb->buf[rb->len] = '\0';
        }
        break;
    default:
        break;
    }
    return ESP_OK;
}

static void set_telemetry_headers(esp_http_client_handle_t client)
{
    char buf[16];
    snprintf(buf, sizeof(buf), "%.2f", s_telemetry.battery_voltage);
    esp_http_client_set_header(client, "X-Battery-Voltage", buf);

    snprintf(buf, sizeof(buf), "%d", s_telemetry.battery_level);
    esp_http_client_set_header(client, "X-Battery-Level", buf);

    if (s_telemetry.power_source) {
        esp_http_client_set_header(client, "X-Power-Source", s_telemetry.power_source);
    }
    if (s_telemetry.battery_status) {
        esp_http_client_set_header(client, "X-Battery-Status", s_telemetry.battery_status);
    }

    snprintf(buf, sizeof(buf), "%d", s_telemetry.wifi_rssi);
    esp_http_client_set_header(client, "X-WiFi-RSSI", buf);
    if (s_telemetry.wifi_ssid_b64) {
        esp_http_client_set_header(client, "X-WiFi-SSID-B64", s_telemetry.wifi_ssid_b64);
    }
    if (s_telemetry.wifi_security) {
        esp_http_client_set_header(client, "X-WiFi-Security", s_telemetry.wifi_security);
    }

    if (s_telemetry.firmware_ver) {
        esp_http_client_set_header(client, "X-Firmware-Ver", s_telemetry.firmware_ver);
    }
    if (s_telemetry.security_profile) {
        esp_http_client_set_header(client, "X-Security-Profile", s_telemetry.security_profile);
    }
    if (s_telemetry.nvs_integrity) {
        esp_http_client_set_header(client, "X-NVS-Integrity", s_telemetry.nvs_integrity);
    }
    if (s_telemetry.chip_model) {
        esp_http_client_set_header(client, "X-Chip-Model", s_telemetry.chip_model);
    }
    snprintf(buf, sizeof(buf), "%u", (unsigned)s_telemetry.chip_revision);
    esp_http_client_set_header(client, "X-Chip-Revision", buf);
    snprintf(buf, sizeof(buf), "%lu", (unsigned long)s_telemetry.flash_size_bytes);
    esp_http_client_set_header(client, "X-Flash-Size", buf);
    if (s_telemetry.partition_layout) {
        esp_http_client_set_header(client, "X-Partition-Layout", s_telemetry.partition_layout);
    }
    if (s_telemetry.partition_fingerprint) {
        esp_http_client_set_header(client, "X-Partition-Fingerprint",
                                   s_telemetry.partition_fingerprint);
    }
    snprintf(buf, sizeof(buf), "%lu", (unsigned long)s_telemetry.partition_table_offset);
    esp_http_client_set_header(client, "X-Partition-Table-Offset", buf);
    esp_http_client_set_header(client, "X-Layout-Verified",
                               s_telemetry.layout_verified ? "1" : "0");
    esp_http_client_set_header(client, "X-Secure-Boot",
                               s_telemetry.secure_boot_enabled ? "1" : "0");
    esp_http_client_set_header(client, "X-Flash-Encryption",
                               s_telemetry.flash_encryption_enabled ? "1" : "0");
    esp_http_client_set_header(client, "X-NVS-Encryption",
                               s_telemetry.nvs_encryption_enabled ? "1" : "0");

    esp_http_client_set_header(client, "X-Display-Model", CONFIG_VELLUM_DISPLAY_MODEL);
}

static void set_auth_header(esp_http_client_handle_t client)
{
    if (strlen(s_token) > 0) {
        esp_http_client_set_header(client, "X-Device-Token", s_token);
    }
}

/* Preserve actionable TLS diagnostics before the HTTP client is cleaned up.
 * The public display must never expose implementation codes, but operators can
 * retrieve them from USB serial logs when investigating a certificate change. */
static void record_transport_failure(esp_http_client_handle_t client,
                                     vellum_http_response_t *resp,
                                     const char *operation,
                                     esp_err_t err,
                                     bool transport_connected)
{
    resp->failure = VELLUM_HTTP_FAILURE_TRANSPORT;
    resp->tls_error_code = 0;
    resp->tls_verify_flags = 0;

    int tls_code = 0;
    int tls_flags = 0;
    esp_err_t tls_err = esp_http_client_get_and_clear_last_tls_error(
        client, &tls_code, &tls_flags);
    resp->tls_error_code = tls_code;
    resp->tls_verify_flags = tls_flags;

    if (tls_flags != 0) {
        resp->failure = VELLUM_HTTP_FAILURE_TLS_CERTIFICATE;
    } else if (tls_code != 0) {
        resp->failure = VELLUM_HTTP_FAILURE_TLS_HANDSHAKE;
    }

    ESP_LOGW(TAG, "%s failed: %s (connected=%s tls=%s code=%d flags=0x%x)",
             operation, esp_err_to_name(err), transport_connected ? "yes" : "no",
             esp_err_to_name(tls_err),
             tls_code, (unsigned int)tls_flags);
}

/* ---- Public API -------------------------------------------------------- */

void http_client_init(const char *server_base_url, const char *mac)
{
    strncpy(s_base_url, server_base_url, sizeof(s_base_url) - 1);
    /* Strip trailing slash */
    size_t len = strlen(s_base_url);
    if (len > 0 && s_base_url[len - 1] == '/') {
        s_base_url[len - 1] = '\0';
    }
    bool allow_private_http = false;
#ifdef CONFIG_VELLUM_ALLOW_INSECURE_PRIVATE_HTTP
    allow_private_http = true;
#endif
    s_base_url_transport_allowed =
        vellum_transport_url_allowed(s_base_url, allow_private_http);
    if (!s_base_url_transport_allowed) {
        ESP_LOGE(TAG, "Server URL rejected by transport policy: %s", s_base_url);
    } else if (strncmp(s_base_url, "http://", 7) == 0) {
        ESP_LOGW(TAG, "DEVELOPMENT ONLY: plaintext private-LAN backend: %s", s_base_url);
    }
    strncpy(s_mac, mac, sizeof(s_mac) - 1);
    s_token[0] = '\0';
    s_public_key[0] = '\0';
    load_etag();
    ESP_LOGI(TAG, "Initialized — server: %s, mac: %s", s_base_url, s_mac);
}

void http_client_set_token(const char *token)
{
    if (token) {
        strncpy(s_token, token, sizeof(s_token) - 1);
        s_token[sizeof(s_token) - 1] = '\0';
    } else {
        s_token[0] = '\0';
    }
}

void http_client_set_public_key(const char *public_key_base64)
{
    if (public_key_base64) {
        strncpy(s_public_key, public_key_base64, sizeof(s_public_key) - 1);
        s_public_key[sizeof(s_public_key) - 1] = '\0';
    } else {
        s_public_key[0] = '\0';
    }
}

void http_client_set_telemetry(const vellum_telemetry_t *telemetry)
{
    if (telemetry) {
        s_telemetry = *telemetry;
    }
}

esp_err_t http_client_hello(vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    if (!s_base_url_transport_allowed) {
        ESP_LOGE(TAG, "Refusing request: server URL violates transport policy");
        return ESP_ERR_NOT_SUPPORTED;
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/hello", s_base_url);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    esp_http_client_set_header(client, "Content-Type", "application/json");
    set_telemetry_headers(client);

    char body[256];
    (void)body; /* reserved for future use */
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "mac", s_mac);
    if (strlen(s_public_key) > 0) {
        cJSON_AddStringToObject(json, "publicKey", s_public_key);
    }

    /* Display capabilities — straight from the driver.
     *
     * This was a four-branch #if chain that restated the geometry, format,
     * palette and orientation of every model. It was a second source of truth
     * for facts the display driver already owned, and the two drifted: the
     * D1001 advertised "portrait 800x1280" while its drawable surface was
     * landscape 1280x800, so a portrait render lost 480px off the bottom and
     * left 480px blank. Serialise what the panel reports; decide nothing here. */
    cJSON *display = cJSON_CreateObject();
    vellum_display_caps_t caps = {0};
    if (display_get_caps(&caps) != ESP_OK) {
        ESP_LOGE(TAG, "Display capabilities unavailable");
        cJSON_Delete(display);
        cJSON_Delete(json);
        return ESP_FAIL;
    }
    cJSON_AddStringToObject(display, "model", caps.model);
    cJSON_AddNumberToObject(display, "width", caps.width);
    cJSON_AddNumberToObject(display, "height", caps.height);
    cJSON_AddStringToObject(display, "format", caps.image_format);
    cJSON_AddStringToObject(display, "colorMode", caps.color_mode);
    if (caps.palette && caps.palette_count) {
        cJSON *palette = cJSON_CreateArray();
        for (uint8_t i = 0; i < caps.palette_count; i++) {
            cJSON *c = cJSON_CreateArray();
            for (uint8_t ch = 0; ch < 3; ch++) {
                cJSON_AddItemToArray(c, cJSON_CreateNumber(caps.palette[i][ch]));
            }
            cJSON_AddItemToArray(palette, c);
        }
        cJSON_AddItemToObject(display, "palette", palette);
    }
    if (caps.reserved_palette_indices && caps.reserved_count) {
        cJSON *reserved = cJSON_CreateArray();
        for (uint8_t i = 0; i < caps.reserved_count; i++) {
            cJSON_AddItemToArray(reserved,
                                 cJSON_CreateNumber(caps.reserved_palette_indices[i]));
        }
        cJSON_AddItemToObject(display, "reservedPaletteIndices", reserved);
    }
    cJSON *orientations = cJSON_CreateArray();
    for (uint8_t i = 0; i < caps.orientation_count; i++) {
        cJSON_AddItemToArray(orientations, cJSON_CreateString(caps.orientations[i]));
    }
    cJSON_AddItemToObject(display, "orientations", orientations);
    cJSON_AddStringToObject(display, "orientation", caps.orientation);

    cJSON_AddItemToObject(json, "display", display);

    char *json_str = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!json_str) {
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_post_field(client, json_str, strlen(json_str));

    esp_err_t err = esp_http_client_perform(client);
    resp->status_code = esp_http_client_get_status_code(client);
    /* esp_http_client returns ESP_ERR_NOT_SUPPORTED for a 401 challenge even
     * when the HTTPS exchange itself completed.  Preserve that HTTP response
     * so the caller can refresh its device token instead of showing a
     * transport/TLS error. */
    if (err == ESP_OK || resp->status_code > 0) {
        resp->body = rb.buf;
        resp->body_len = rb.len;
        ESP_LOGI(TAG, "POST /hello → %d", resp->status_code);
        err = ESP_OK;
    } else {
        record_transport_failure(client, resp, "POST /hello", err,
                                 rb.transport_connected);
        free(rb.buf);
    }

    cJSON_free(json_str);
    esp_http_client_cleanup(client);
    return err;
}



static void load_etag(void) {
    nvs_manager_get_str("etag", s_last_etag, sizeof(s_last_etag));
}

static void save_etag(const char *etag) {
    strlcpy(s_last_etag, etag, sizeof(s_last_etag));
    nvs_manager_set_str("etag", s_last_etag);
}

void http_client_commit_render_etag(const char *etag)
{
    if (etag && etag[0]) save_etag(etag);
}

esp_err_t http_client_render(vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    if (!s_base_url_transport_allowed) {
        ESP_LOGE(TAG, "Refusing request: server URL violates transport policy");
        return ESP_ERR_NOT_SUPPORTED;
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/render?mac=%s", s_base_url, s_mac);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    set_telemetry_headers(client);
    set_auth_header(client);
    esp_http_client_set_header(client, "X-Display-Model", CONFIG_VELLUM_DISPLAY_MODEL);

    /* Send last content hash — server returns 304 if unchanged */
    if (s_last_etag[0]) {
        esp_http_client_set_header(client, "If-None-Match", s_last_etag);
    }

    esp_err_t err = esp_http_client_perform(client);
    resp->status_code = esp_http_client_get_status_code(client);
    /* A complete HTTP error response (notably 401 with WWW-Authenticate)
     * is not a TLS failure.  Let the caller inspect its status and recover
     * its device token. */
    if (err == ESP_OK || resp->status_code > 0) {

        /* Response headers are delivered through HTTP_EVENT_ON_HEADER. The
         * similarly named esp_http_client_get_header() reads REQUEST headers
         * and therefore silently returned nothing here. That kept displays on
         * the 900 s fallback while the server expected a 60 s USB cadence. */
        resp->sleep_duration = rb.headers.sleep_duration;
        if (rb.headers.error_backoff[0]) {
            strlcpy(resp->error_backoff, rb.headers.error_backoff,
                    sizeof(resp->error_backoff));
        }
        if (rb.headers.etag[0]) {
            strlcpy(resp->etag, rb.headers.etag, sizeof(resp->etag));
        }

        if (resp->status_code == 200) {
            resp->binary_body = (uint8_t *)rb.buf;
            resp->binary_len = rb.len;
            rb.buf = NULL;
            ESP_LOGI(TAG, "GET /render → 200, %zu bytes", resp->binary_len);
        } else if (resp->status_code == 304) {
            free(rb.buf);
            rb.buf = NULL;
            ESP_LOGI(TAG, "GET /render → 304 (unchanged)");
        } else {
            resp->body = rb.buf;
            resp->body_len = rb.len;
            rb.buf = NULL;
            ESP_LOGI(TAG, "GET /render → %d", resp->status_code);
        }
        err = ESP_OK;
    } else {
        record_transport_failure(client, resp, "GET /render", err,
                                 rb.transport_connected);
        free(rb.buf);
    }

    esp_http_client_cleanup(client);
    return err;
}

esp_err_t http_client_report(const char *issue, vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    if (!s_base_url_transport_allowed) {
        ESP_LOGE(TAG, "Refusing request: server URL violates transport policy");
        return ESP_ERR_NOT_SUPPORTED;
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/report", s_base_url);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    esp_http_client_set_header(client, "Content-Type", "application/json");
    set_telemetry_headers(client);
    set_auth_header(client);

    /* Build JSON body safely with cJSON to prevent injection */
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "mac", s_mac);
    cJSON_AddStringToObject(json, "issue", issue ? issue : "");
    char *body = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!body) {
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_post_field(client, body, strlen(body));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        resp->status_code = esp_http_client_get_status_code(client);
        resp->body = rb.buf;
        resp->body_len = rb.len;
        rb.buf = NULL;
        ESP_LOGI(TAG, "POST /report → %d", resp->status_code);
    } else {
        ESP_LOGW(TAG, "POST /report failed: %s", esp_err_to_name(err));
        free(rb.buf);
    }

    cJSON_free(body);
    esp_http_client_cleanup(client);
    return err;
}

esp_err_t http_client_ota_report(const char *model, const char *from_version,
                                 const char *to_version, const char *phase,
                                 const char *error_code)
{
    if (!s_base_url_transport_allowed) {
        ESP_LOGE(TAG, "Refusing request: server URL violates transport policy");
        return ESP_ERR_NOT_SUPPORTED;
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/ota-report", s_base_url);

    resp_buf_t rb = {0};
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    esp_http_client_set_header(client, "Content-Type", "application/json");
    set_auth_header(client);

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "mac", s_mac);
    if (model && model[0]) cJSON_AddStringToObject(json, "model", model);
    if (from_version && from_version[0]) cJSON_AddStringToObject(json, "fromVersion", from_version);
    if (to_version && to_version[0]) cJSON_AddStringToObject(json, "toVersion", to_version);
    cJSON_AddStringToObject(json, "phase", phase ? phase : "");
    if (error_code && error_code[0]) cJSON_AddStringToObject(json, "errorCode", error_code);
    char *body = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!body) {
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_post_field(client, body, strlen(body));

    esp_err_t err = esp_http_client_perform(client);
    ESP_LOGI(TAG, "POST /ota-report [%s] → %d", phase ? phase : "?",
             err == ESP_OK ? esp_http_client_get_status_code(client) : -1);

    cJSON_free(body);
    free(rb.buf);
    esp_http_client_cleanup(client);
    return err;
}


/**
 * Report the drawable surface and the mountings this panel supports, on every
 * poll rather than once at enrolment.
 *
 * Capabilities used to travel only in http_client_hello(), so they were pinned to
 * a one-off event while the firmware they describe keeps changing. A display
 * enrolled with wrong geometry kept it forever: correcting the driver could never
 * reach the record, which is why a D1001 still advertised portrait 800x1280 long
 * after its surface became landscape.
 *
 * Only what the server cannot derive goes here. Palette, format and colour mode
 * follow from the model, which already travels in x-display-model, so sending them
 * every 60 seconds would be waste. A header keeps this backwards compatible in
 * both directions: an older server ignores it, an older device omits it.
 */
static void set_caps_header(esp_http_client_handle_t client)
{
    vellum_display_caps_t caps = {0};
    if (display_get_caps(&caps) != ESP_OK) return;

    char orientations[64] = {0};
    size_t used = 0;
    for (uint8_t i = 0; i < caps.orientation_count && used < sizeof(orientations); i++) {
        int n = snprintf(orientations + used, sizeof(orientations) - used, "%s%s",
                         used ? "," : "", caps.orientations[i]);
        if (n < 0 || (size_t)n >= sizeof(orientations) - used) break;
        used += (size_t)n;
    }

    char value[160];
    snprintf(value, sizeof(value), "%ux%u;%s;%s", (unsigned)caps.width,
             (unsigned)caps.height, caps.orientation ? caps.orientation : "",
             orientations);
    esp_http_client_set_header(client, "X-Display-Caps", value);
}

esp_err_t http_client_config(vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    if (!s_base_url_transport_allowed) {
        ESP_LOGE(TAG, "Refusing request: server URL violates transport policy");
        return ESP_ERR_NOT_SUPPORTED;
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/config?mac=%s", s_base_url, s_mac);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    set_telemetry_headers(client);
    set_caps_header(client);
    set_auth_header(client);

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        resp->status_code = esp_http_client_get_status_code(client);
        resp->body = rb.buf;
        resp->body_len = rb.len;
        rb.buf = NULL;
        ESP_LOGI(TAG, "GET /config → %d", resp->status_code);
    } else {
        ESP_LOGW(TAG, "GET /config failed: %s", esp_err_to_name(err));
        free(rb.buf);
    }

    esp_http_client_cleanup(client);
    return err;
}

esp_err_t http_client_probe_server(const char *server_base_url, const char *command_id)
{
    if (!server_base_url || !command_id || strlen(server_base_url) >= NVS_MAX_URL_LEN) {
        return ESP_ERR_INVALID_ARG;
    }
    bool allow_private_http = false;
#ifdef CONFIG_VELLUM_ALLOW_INSECURE_PRIVATE_HTTP
    allow_private_http = true;
#endif
    if (!vellum_transport_url_allowed(server_base_url, allow_private_http)) {
        return ESP_ERR_NOT_SUPPORTED;
    }

    char url[512];
    int written = snprintf(url, sizeof(url), "%s/api/v1/ink/config?mac=%s",
                           server_base_url, s_mac);
    if (written < 0 || written >= (int)sizeof(url)) return ESP_ERR_INVALID_SIZE;
    resp_buf_t rb = {0};
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;
    set_telemetry_headers(client);
    set_auth_header(client);
    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
    esp_http_client_cleanup(client);
    if (err != ESP_OK || status != 200 || !rb.buf) {
        free(rb.buf);
        return err == ESP_OK ? ESP_ERR_INVALID_RESPONSE : err;
    }

    cJSON *root = cJSON_ParseWithLength(rb.buf, rb.len);
    cJSON *data = root ? cJSON_GetObjectItemCaseSensitive(root, "data") : NULL;
    cJSON *remote = data ? cJSON_GetObjectItemCaseSensitive(data, "remoteConfiguration") : NULL;
    cJSON *id = remote ? cJSON_GetObjectItemCaseSensitive(remote, "id") : NULL;
    bool matches = cJSON_IsString(id) && id->valuestring &&
                   strcmp(id->valuestring, command_id) == 0;
    cJSON_Delete(root);
    free(rb.buf);
    return matches ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

esp_err_t http_client_config_report(const char *command_id, const char *status,
                                    const char *error_code)
{
    if (!command_id || !status || !s_base_url_transport_allowed) return ESP_ERR_INVALID_ARG;
    char url[512];
    int written = snprintf(url, sizeof(url), "%s/api/v1/ink/config-report", s_base_url);
    if (written < 0 || written >= (int)sizeof(url)) return ESP_ERR_INVALID_SIZE;
    resp_buf_t rb = {0};
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .disable_auto_redirect = true,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;
    set_auth_header(client);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    cJSON *json = cJSON_CreateObject();
    if (!json) { esp_http_client_cleanup(client); return ESP_ERR_NO_MEM; }
    cJSON_AddStringToObject(json, "mac", s_mac);
    cJSON_AddStringToObject(json, "id", command_id);
    cJSON_AddStringToObject(json, "status", status);
    if (error_code && error_code[0]) cJSON_AddStringToObject(json, "errorCode", error_code);
    char *body = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!body) { esp_http_client_cleanup(client); return ESP_ERR_NO_MEM; }
    esp_http_client_set_post_field(client, body, strlen(body));
    esp_err_t err = esp_http_client_perform(client);
    int response_status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;
    cJSON_free(body);
    free(rb.buf);
    esp_http_client_cleanup(client);
    if (err != ESP_OK) return err;
    return response_status >= 200 && response_status < 300 ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

void http_client_free_response(vellum_http_response_t *resp)
{
    if (resp->body) {
        free(resp->body);
        resp->body = NULL;
        resp->body_len = 0;
    }
    if (resp->binary_body) {
        free(resp->binary_body);
        resp->binary_body = NULL;
        resp->binary_len = 0;
    }
}
