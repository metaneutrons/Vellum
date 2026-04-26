/**
 * @file http_client.c
 * @brief ESP-IDF HTTP client implementation for Vellum backend.
 */

#include "http_client.h"
#include "nvs_manager.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "cJSON.h"

static const char *TAG = "http_cli";

/** Maximum response body size (256 KB) to prevent OOM on malicious responses */
#define MAX_RESPONSE_SIZE (512 * 1024)

static char s_base_url[NVS_MAX_URL_LEN];
static char s_mac[13];
static char s_token[NVS_MAX_TOKEN_LEN];
static char s_public_key[64]; /* base64-encoded X25519 public key (44 chars + null) */
static char s_last_etag[32] = {0};
static void load_etag(void);
static void save_etag(const char *etag);
static vellum_telemetry_t s_telemetry = {0};

/* ---- internal helpers -------------------------------------------------- */

/**
 * Event handler that accumulates response body into a dynamically
 * growing buffer attached to the user_data pointer.
 */
typedef struct {
    char   *buf;
    size_t  len;
    size_t  cap;
} resp_buf_t;

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    resp_buf_t *rb = (resp_buf_t *)evt->user_data;
    if (!rb) return ESP_OK;

    switch (evt->event_id) {
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

    snprintf(buf, sizeof(buf), "%d", s_telemetry.wifi_rssi);
    esp_http_client_set_header(client, "X-WiFi-RSSI", buf);

    if (s_telemetry.firmware_ver) {
        esp_http_client_set_header(client, "X-Firmware-Ver", s_telemetry.firmware_ver);
    }

    esp_http_client_set_header(client, "X-Display-Model", CONFIG_VELLUM_DISPLAY_MODEL);
}

static void set_auth_header(esp_http_client_handle_t client)
{
    if (strlen(s_token) > 0) {
        esp_http_client_set_header(client, "X-Device-Token", s_token);
    }
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

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/hello", s_base_url);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = false,
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

    /* Display capabilities — server uses these for rendering */
    cJSON *display = cJSON_CreateObject();
    cJSON_AddStringToObject(display, "model", CONFIG_VELLUM_DISPLAY_MODEL);
#if defined(CONFIG_VELLUM_PANEL_GDEP073E01)
    cJSON_AddNumberToObject(display, "width", 800);
    cJSON_AddNumberToObject(display, "height", 480);
    cJSON_AddStringToObject(display, "quantize", "color");
    cJSON *palette = cJSON_CreateArray();
    int colors[][3] = {{0,0,0},{255,255,255},{255,255,0},{255,0,0},{255,128,0},{0,0,255},{0,255,0}};
    for (int i = 0; i < 7; i++) {
        cJSON *c = cJSON_CreateArray();
        cJSON_AddItemToArray(c, cJSON_CreateNumber(colors[i][0]));
        cJSON_AddItemToArray(c, cJSON_CreateNumber(colors[i][1]));
        cJSON_AddItemToArray(c, cJSON_CreateNumber(colors[i][2]));
        cJSON_AddItemToArray(palette, c);
    }
    cJSON_AddItemToObject(display, "palette", palette);
#elif defined(CONFIG_VELLUM_PANEL_GDEY075T7)
    cJSON_AddNumberToObject(display, "width", 800);
    cJSON_AddNumberToObject(display, "height", 480);
    cJSON_AddStringToObject(display, "quantize", "mono");
    cJSON *palette = cJSON_CreateArray();
    int bw[][3] = {{0,0,0},{255,255,255}};
    for (int i = 0; i < 2; i++) {
        cJSON *c = cJSON_CreateArray();
        cJSON_AddItemToArray(c, cJSON_CreateNumber(bw[i][0]));
        cJSON_AddItemToArray(c, cJSON_CreateNumber(bw[i][1]));
        cJSON_AddItemToArray(c, cJSON_CreateNumber(bw[i][2]));
        cJSON_AddItemToArray(palette, c);
    }
    cJSON_AddItemToObject(display, "palette", palette);
#endif
    cJSON_AddItemToObject(json, "display", display);

    char *json_str = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!json_str) {
        esp_http_client_cleanup(client);
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_post_field(client, json_str, strlen(json_str));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        resp->status_code = esp_http_client_get_status_code(client);
        resp->body = rb.buf;
        resp->body_len = rb.len;
        ESP_LOGI(TAG, "POST /hello → %d", resp->status_code);
    } else {
        ESP_LOGW(TAG, "POST /hello failed: %s", esp_err_to_name(err));
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
    strncpy(s_last_etag, etag, sizeof(s_last_etag) - 1);
    nvs_manager_set_str("etag", s_last_etag);
}

esp_err_t http_client_render(vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/render?mac=%s", s_base_url, s_mac);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .disable_auto_redirect = false,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    set_telemetry_headers(client);
    set_auth_header(client);

    /* Send last content hash — server returns 304 if unchanged */
    if (s_last_etag[0]) {
        esp_http_client_set_header(client, "If-None-Match", s_last_etag);
    }

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        resp->status_code = esp_http_client_get_status_code(client);

        /* Parse X-Sleep-Duration header */
        char *sleep_hdr_val = NULL;
        esp_http_client_get_header(client, "X-Sleep-Duration", &sleep_hdr_val);
        if (sleep_hdr_val) {
            int parsed = atoi(sleep_hdr_val);
            if (parsed > 0) {
                resp->sleep_duration = parsed;
            }
        }

        /* Store ETag for next request */
        char *etag_val = NULL;
        esp_http_client_get_header(client, "ETag", &etag_val);
        if (etag_val) {
            save_etag(etag_val);
        }

        if (resp->status_code == 200) {
            resp->binary_body = (uint8_t *)rb.buf;
            resp->binary_len = rb.len;
            rb.buf = NULL;
            ESP_LOGI(TAG, "GET /render → 200, %zu bytes", resp->binary_len);
        } else if (resp->status_code == 304) {
            ESP_LOGI(TAG, "GET /render → 304 (unchanged)");
        } else {
            resp->body = rb.buf;
            resp->body_len = rb.len;
            rb.buf = NULL;
            ESP_LOGI(TAG, "GET /render → %d", resp->status_code);
        }
    } else {
        ESP_LOGW(TAG, "GET /render failed: %s", esp_err_to_name(err));
        free(rb.buf);
    }

    esp_http_client_cleanup(client);
    return err;
}

esp_err_t http_client_report(const char *issue, vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/report", s_base_url);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .crt_bundle_attach = esp_crt_bundle_attach,
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

esp_err_t http_client_config(vellum_http_response_t *resp)
{
    memset(resp, 0, sizeof(*resp));
    resp->status_code = -1;

    char url[512];
    snprintf(url, sizeof(url), "%s/api/v1/ink/config?mac=%s", s_base_url, s_mac);

    resp_buf_t rb = {0};

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = CONFIG_VELLUM_HTTP_TIMEOUT_MS,
        .event_handler = http_event_handler,
        .user_data = &rb,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_FAIL;

    set_telemetry_headers(client);
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
