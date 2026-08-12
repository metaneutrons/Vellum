// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file wifi_manager.c
 * @brief ESP-IDF Wi-Fi station + SoftAP captive portal implementation.
 */

#include "wifi_manager.h"
#include "wifi_failure.h"
#include "nvs_manager.h"
#include "transport_policy.h"

#include "cJSON.h"
#include <string.h>
#include "sdkconfig.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "lwip/ip4_addr.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"

#if CONFIG_VELLUM_DISPLAY_IS_LCD
extern uint8_t is_transport_tx_ready(void);
#endif

static const char *TAG = "wifi_mgr";

/* Wait for ESP-Hosted transport on P4 (no-op on S3) */
static void wait_for_wifi_transport(void)
{
#if CONFIG_VELLUM_DISPLAY_IS_LCD
    ESP_LOGI(TAG, "Waiting for ESP-Hosted transport...");
    for (int i = 0; i < 100 && !is_transport_tx_ready(); i++) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!is_transport_tx_ready()) {
        ESP_LOGE(TAG, "ESP-Hosted transport not ready after 10s");
    }
#endif
}

/* Event group bits */
#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1
#define WIFI_SCAN_STA_STARTED_BIT BIT0
#define WIFI_SCAN_START_TIMEOUT_MS 5000
#define WIFI_SCAN_READY_SETTLE_MS 250
#define WIFI_SCAN_STATE_RETRIES 10
#define WIFI_SCAN_STATE_RETRY_MS 200

static EventGroupHandle_t s_wifi_event_group;
static int s_retry_count = 0;
static bool s_netif_initialized = false;
static bool s_wifi_initialized = false;
static bool s_wifi_started = false;
static esp_netif_t *s_sta_netif = NULL;
static esp_netif_t *s_ap_netif = NULL;
static SemaphoreHandle_t s_wifi_mutex = NULL;
static volatile bool s_credentials_received = false;
static uint8_t s_last_disconnect_reason = 0;
static wifi_failure_kind_t s_last_failure = WIFI_FAILURE_UNKNOWN;

static void wifi_scan_event_handler(void *arg, esp_event_base_t event_base,
                                    int32_t event_id, void *event_data)
{
    (void)event_data;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START && arg) {
        xEventGroupSetBits((EventGroupHandle_t)arg, WIFI_SCAN_STA_STARTED_BIT);
    }
}

static const char *wifi_auth_mode_name(wifi_auth_mode_t authmode)
{
    switch (authmode) {
    case WIFI_AUTH_OPEN: return "open";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA-PSK";
    case WIFI_AUTH_WPA2_PSK: return "WPA2-PSK";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2-PSK";
    case WIFI_AUTH_WPA3_PSK: return "WPA3-SAE";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3 transition";
    case WIFI_AUTH_OWE: return "OWE";
    case WIFI_AUTH_WPA3_ENT_192: return "WPA3-Enterprise 192-bit";
    case WIFI_AUTH_DPP: return "DPP";
    case WIFI_AUTH_WPA3_ENTERPRISE: return "WPA3-Enterprise";
    case WIFI_AUTH_WPA2_WPA3_ENTERPRISE: return "WPA2/WPA3-Enterprise";
    case WIFI_AUTH_WPA_ENTERPRISE: return "WPA-Enterprise";
    default: return "unknown";
    }
}

/* ---- Captive portal HTML (embedded) ------------------------------------ */

static const char PORTAL_HTML[] =
    "<!DOCTYPE html><html lang=\"en\"><head>"
    "<meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum Setup</title>"
    "<style>"
    "*{margin:0;padding:0;box-sizing:border-box}"
    "body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}"
    ".card{width:100%;max-width:400px}"
    ".logo{text-align:center;margin-bottom:32px}"
    ".logo svg{width:240px;height:240px}"
    "h2{font-size:18px;color:#94a3b8;font-weight:400;text-align:center;margin-bottom:28px}"
    ".form-card{background:#13141f;border:1px solid #1e2030;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.4)}"
    ".field{padding:16px 20px;border-bottom:1px solid #1e2030}"
    ".field:last-child{border-bottom:none}"
    ".field label{display:block;font-size:11px;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.8px;font-weight:500}"
    ".field input,.field select{width:100%;background:transparent;border:none;color:#f1f5f9;font-size:16px;outline:none}"
    ".field input::placeholder{color:#334155}"
    ".hint{font-size:11px;color:#475569;margin-top:6px;line-height:1.4}"
    "button{width:100%;margin-top:20px;padding:14px;background:#e9177b;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:background 0.2s}"
    "button:hover{background:#c4146a}"
    ".footer{text-align:center;margin-top:24px;font-size:11px;color:#334155}"
    "</style></head><body>"
    "<div class=\"card\">"
    "<div class=\"logo\">"
    "<svg viewBox=\"0 0 2048 2048\" xmlns=\"http://www.w3.org/2000/svg\">"
    "<polygon points=\"546.8 411.5 600.9 497.5 910.6 985.4 1024.2 1165 1199.8 887.9 1448.4 496.3 1502.2 411.5 1639.2 411.5 1639.3 530.5 1442.1 828.3 1203.9 1188 1024 1460.5 928.9 1315.2 649.6 893.5 408.7 530.2 408.8 411.5 546.8 411.5\" fill=\"#e2e8f0\"/>"
    "<g><polygon points=\"786.1 1170.8 841 1252.8 409 1252.8 409 608 513.7 760 513.6 1170.7 786.1 1170.8\" fill=\"#64748b\"/>"
    "<polygon points=\"1262.2 1170.9 1534.6 1170.7 1534.7 760.2 1639.2 608.1 1639.3 1252.7 1207.5 1252.8 1262.2 1170.9\" fill=\"#64748b\"/>"
    "<path d=\"M1502.2,411.5l-53.8,84.8-844.1-.2c-2.3-.6-3,.4-3.4,1.3l-54.1-86h955.4Z\" fill=\"#64748b\"/></g>"
    "<path d=\"M1082.4,960.9l-58.2,92.1-90.4-143.6-140.9-222-85.7-135.6h633.9l-63.2,100.4-195.5,308.7h0ZM1200.5,630.2h-352.3l175.9,278.4,176.4-278.4h0Z\" fill=\"#e9177b\"/>"
    "<polygon points=\"1101.6 690 1024.2 813.5 946.4 689.9 1101.6 690\" fill=\"#e2e8f0\"/>"
    "<g><polygon points=\"1591.7 1710.9 1591.4 1596.4 1532.7 1690.2 1509.6 1690.2 1449.6 1597.4 1449.5 1711 1405.2 1710.9 1405.1 1519.3 1447.4 1519.3 1521.4 1636.3 1594.3 1519.3 1637.5 1519.2 1637.5 1710.9 1591.7 1710.9\" fill=\"#e2e8f0\"/>"
    "<polygon points=\"789.6 1630.6 695.6 1630.7 695.6 1672.5 806.3 1672.5 806.3 1710.9 648.1 1710.9 648.1 1519.3 800.7 1519.3 800.6 1556.3 695.6 1556.3 695.6 1593.7 789.4 1593.7 789.6 1630.6\" fill=\"#e2e8f0\"/>"
    "<path d=\"M1316.5,1519.3h47.3c0,0,0,100.8,0,100.8.2,37.3-11.3,71.1-46.9,86.4-28.7,12.3-62.1,12.2-90.6-.7-33.4-15.1-45.4-46.2-45.5-81.8v-104.9h47.2v106.8c.3,21.1,7.9,40.7,28.7,46.2,10.2,2.7,20.8,2.7,30.9,0,20.5-5.6,28.2-25.3,28.9-46.2v-106.7h0Z\" fill=\"#e2e8f0\"/>"
    "<polygon points=\"581.9 1519.3 630.1 1519.4 543.8 1710.9 496 1710.9 409 1519.6 461.1 1519.4 521.3 1654.3 552.7 1583.1 581.9 1519.3\" fill=\"#e2e8f0\"/>"
    "<polygon points=\"985.7 1672.5 986 1710.9 839.5 1710.9 839.6 1519.2 888.1 1519.3 888.1 1672.5 985.7 1672.5\" fill=\"#e2e8f0\"/>"
    "<polygon points=\"1159.9 1672.5 1159.9 1711 1012.4 1710.9 1012.4 1519.2 1060.6 1519.1 1060.5 1672.5 1159.9 1672.5\" fill=\"#e2e8f0\"/></g>"
    "</svg></div>"
    "<h2>Connect your display to WiFi</h2>"
    "<form method=\"POST\" action=\"/save\">"
    "<div class=\"form-card\">"
    "<div class=\"field\"><label>WiFi Network</label>"
    "<select name=\"ssid\" id=\"ssid\" required><option value=\"\">Scanning...</option></select>"
    "<div class=\"hint\" id=\"scan-hint\">Searching for networks...</div></div>"
    "<div class=\"field\"><label>Password</label>"
    "<input type=\"password\" name=\"pass\" maxlength=\"64\" placeholder=\"WiFi password\"></div>"
    "<div class=\"field\"><label>Server URL</label>"
    "<input type=\"text\" name=\"server\" maxlength=\"200\" placeholder=\"https://vellum.company.com\">"
    "<div class=\"hint\">Must be an https:// URL with a valid certificate. Leave empty to auto-discover via mDNS.</div></div>"
    "</div>"
    "<button type=\"submit\">Connect</button>"
    "</form>"
    "<div class=\"footer\">Vellum &mdash; Enterprise Display Management</div>"
    "</div>"
    "<script>"
    "fetch('/scan').then(r=>r.json()).then(nets=>{"
    "let s=document.getElementById('ssid');"
    "s.innerHTML='<option value=\"\">Select network...</option>';"
    "nets.forEach(n=>{"
    "let o=document.createElement('option');"
    "o.value=n.ssid;o.textContent=n.ssid+' ('+n.rssi+'dBm)';"
    "s.appendChild(o)});"
    "document.getElementById('scan-hint').textContent=nets.length+' networks found';"
    "}).catch(()=>{document.getElementById('scan-hint').textContent='Scan failed — enter manually';"
    "let s=document.getElementById('ssid');"
    "s.outerHTML='<input type=\"text\" name=\"ssid\" maxlength=\"32\" required placeholder=\"Network name\">'});"
    "</script>"
    "</body></html>";

static const char PORTAL_SUCCESS_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>"
    "body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}"
    ".icon{font-size:56px;margin-bottom:20px}"
    "h1{color:#22c55e;font-size:22px;margin-bottom:10px}"
    "p{color:#94a3b8;font-size:15px;line-height:1.5}"
    "</style></head><body><div>"
    "<div class=\"icon\">\xe2\x9c\x93</div>"
    "<h1>Connected!</h1>"
    "<p>Your display will restart and connect to the network.<br>This page will close automatically.</p>"
    "</div></body></html>";

static const char PORTAL_ERROR_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>"
    "body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}"
    "h1{color:#ef4444;font-size:22px;margin-bottom:10px}"
    "p{color:#94a3b8;font-size:15px}"
    "a{color:#e9177b;text-decoration:none;font-weight:500}"
    "a:hover{text-decoration:underline}"
    "</style></head><body><div>"
    "<h1>Something went wrong</h1>"
    "<p>Network name is required.<br><a href=\"/\">Try again</a></p>"
    "</div></body></html>";

static const char PORTAL_INSECURE_URL_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>"
    "body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px}"
    "h1{color:#ef4444;font-size:22px;margin-bottom:10px}p{color:#94a3b8;font-size:15px;line-height:1.5}"
    "a{color:#e9177b;text-decoration:none;font-weight:500}</style></head><body><div>"
    "<h1>Secure server required</h1>"
    "<p>This production firmware only accepts an <strong>https://</strong> server URL.<br>"
    "Your Wi-Fi and server settings were not changed.<br><a href=\"/\">Try again</a></p>"
    "</div></body></html>";

static bool provisioning_url_allowed(const char *url)
{
    bool allow_private_http = false;
#ifdef CONFIG_VELLUM_ALLOW_INSECURE_PRIVATE_HTTP
    allow_private_http = true;
#endif
    return !url || !url[0] || vellum_transport_url_allowed(url, allow_private_http);
}

/* ---- Wi-Fi event handler ----------------------------------------------- */

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_CONNECTED) {
        const wifi_event_sta_connected_t *event =
            (const wifi_event_sta_connected_t *)event_data;
        if (event) {
            ESP_LOGI(TAG, "Associated using %s (channel=%u)",
                     wifi_auth_mode_name(event->authmode), event->channel);
        }
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *event =
            (const wifi_event_sta_disconnected_t *)event_data;
        s_last_disconnect_reason = event ? event->reason : 0;
        s_last_failure = wifi_failure_from_disconnect_reason(s_last_disconnect_reason);
        ESP_LOGW(TAG, "Station disconnected (reason=%u, %s)",
                 s_last_disconnect_reason, wifi_failure_message(s_last_failure));
        if (s_retry_count < CONFIG_VELLUM_WIFI_MAX_RETRIES) {
            s_retry_count++;
            ESP_LOGI(TAG, "Retry %d/%d", s_retry_count, CONFIG_VELLUM_WIFI_MAX_RETRIES);
            esp_wifi_connect();
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
        }
    } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected. IP: " IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_count = 0;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

/* ---- Captive portal HTTP handlers -------------------------------------- */

static esp_err_t portal_root_handler(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PORTAL_HTML, HTTPD_RESP_USE_STRLEN);
}

/**
 * Parse a URL-encoded form body to extract a named field value.
 * Returns the length written to out_val (excluding null), or -1 on not found.
 */
static int parse_form_field(const char *body, const char *field,
                            char *out_val, size_t out_len)
{
    size_t flen = strlen(field);
    const char *p = body;

    while ((p = strstr(p, field)) != NULL) {
        /* Ensure it's at start or preceded by '&' */
        if (p != body && *(p - 1) != '&') { p += flen; continue; }
        if (p[flen] != '=') { p += flen; continue; }

        const char *val = p + flen + 1;
        const char *end = strchr(val, '&');
        size_t vlen = end ? (size_t)(end - val) : strlen(val);
        if (vlen >= out_len) vlen = out_len - 1;

        /* Basic URL-decode in place (only + → space, %XX) */
        size_t wi = 0;
        for (size_t ri = 0; ri < vlen && wi < out_len - 1; ri++) {
            if (val[ri] == '+') {
                out_val[wi++] = ' ';
            } else if (val[ri] == '%' && ri + 2 < vlen) {
                char hex[3] = { val[ri+1], val[ri+2], '\0' };
                out_val[wi++] = (char)strtol(hex, NULL, 16);
                ri += 2;
            } else {
                out_val[wi++] = val[ri];
            }
        }
        out_val[wi] = '\0';
        return (int)wi;
    }
    return -1;
}

static esp_err_t portal_save_handler(httpd_req_t *req)
{
    /* The form body (ssid + pass + server URL, each URL-encoded) can exceed the
     * old 256-byte buffer — a single truncating recv() silently corrupted the
     * saved server URL. Size for the worst case, READ THE WHOLE BODY in a loop,
     * and reject anything larger rather than storing a truncated value. */
    char buf[1025];
    if (req->content_len <= 0 || req->content_len >= (int)sizeof(buf)) {
        httpd_resp_set_status(req, "400 Bad Request");
        return httpd_resp_send(req, PORTAL_ERROR_HTML, HTTPD_RESP_USE_STRLEN);
    }
    int received = 0;
    while (received < req->content_len) {
        int r = httpd_req_recv(req, buf + received, req->content_len - received);
        if (r == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (r <= 0) {
            httpd_resp_set_status(req, "400 Bad Request");
            return httpd_resp_send(req, PORTAL_ERROR_HTML, HTTPD_RESP_USE_STRLEN);
        }
        received += r;
    }
    buf[received] = '\0';

    char ssid[NVS_MAX_SSID_LEN] = {0};
    char pass[NVS_MAX_PASS_LEN] = {0};
    char server[NVS_MAX_URL_LEN] = {0};

    parse_form_field(buf, "ssid", ssid, sizeof(ssid));
    parse_form_field(buf, "pass", pass, sizeof(pass));
    parse_form_field(buf, "server", server, sizeof(server));

    if (strlen(ssid) == 0) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "text/html");
        return httpd_resp_send(req, PORTAL_ERROR_HTML, HTTPD_RESP_USE_STRLEN);
    }

    if (!provisioning_url_allowed(server)) {
        /* Do not log the supplied URL: it may contain userinfo or tokens. */
        ESP_LOGW(TAG, "Portal: server URL rejected by build policy");
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "text/html");
        return httpd_resp_send(req, PORTAL_INSECURE_URL_HTML, HTTPD_RESP_USE_STRLEN);
    }

    esp_err_t err = nvs_manager_store_wifi(ssid, pass);
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_send(req, "<h1>Storage error</h1>", HTTPD_RESP_USE_STRLEN);
    }

    /* Store server URL if provided */
    if (strlen(server) > 0) {
        nvs_manager_store_server_url(server);
        ESP_LOGI(TAG, "Server URL stored: %s", server);
    }

    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, PORTAL_SUCCESS_HTML, HTTPD_RESP_USE_STRLEN);
    s_credentials_received = true;
    return ESP_OK;
}

/* Redirect unknown paths → captive portal root */
/* WiFi scan endpoint — returns JSON array of networks */
int wifi_manager_scan(wifi_ap_info_t *out, int max)
{
    if (!out || max <= 0) return 0;

    wifi_manager_init();
    xSemaphoreTake(s_wifi_mutex, portMAX_DELAY);

    /* Scanning needs STA capability; APSTA keeps a running SoftAP portal alive.
     * Capture the current mode so we can restore it — otherwise a standalone
     * scan (Improv SCAN_WIFI with no following connect) strands the radio in
     * APSTA. */
    wifi_mode_t prev_mode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&prev_mode);
    bool was_started = s_wifi_started;
    bool station_was_started = was_started &&
        (prev_mode == WIFI_MODE_STA || prev_mode == WIFI_MODE_APSTA);
    EventGroupHandle_t scan_events = NULL;
    esp_event_handler_instance_t scan_handler = NULL;
    bool scan_handler_registered = false;
    int n = 0;
    wifi_mode_t scan_mode =
        (prev_mode == WIFI_MODE_AP || prev_mode == WIFI_MODE_APSTA)
            ? WIFI_MODE_APSTA : WIFI_MODE_STA;

    /* ESP-Hosted changes the C6 radio mode asynchronously. On D1001, asking
     * for a scan before WIFI_EVENT_STA_START arrives fails with
     * ESP_ERR_WIFI_STATE. Local-radio targets tend to hide this race. */
    if (!station_was_started) {
        scan_events = xEventGroupCreate();
        if (!scan_events ||
            esp_event_handler_instance_register(WIFI_EVENT, WIFI_EVENT_STA_START,
                                                wifi_scan_event_handler, scan_events,
                                                &scan_handler) != ESP_OK) {
            if (scan_events) vEventGroupDelete(scan_events);
            xSemaphoreGive(s_wifi_mutex);
            return 0;
        }
        scan_handler_registered = true;
    }

    if (esp_wifi_set_mode(scan_mode) != ESP_OK) {
        goto cleanup;
    }
    if (!s_wifi_started) {
        if (esp_wifi_start() != ESP_OK) {
            goto cleanup;
        }
        s_wifi_started = true;
    }

    if (!station_was_started) {
        EventBits_t bits = xEventGroupWaitBits(scan_events, WIFI_SCAN_STA_STARTED_BIT,
                                               pdFALSE, pdTRUE,
                                               pdMS_TO_TICKS(WIFI_SCAN_START_TIMEOUT_MS));
        if (!(bits & WIFI_SCAN_STA_STARTED_BIT)) {
            ESP_LOGE(TAG, "Station did not become scan-ready within %d ms",
                     WIFI_SCAN_START_TIMEOUT_MS);
            goto cleanup;
        }
        /* ESP-Hosted forwards STA_START before the C6 RPC endpoint accepts a
         * scan. Give the remote state machine a brief chance to settle. */
        vTaskDelay(pdMS_TO_TICKS(WIFI_SCAN_READY_SETTLE_MS));
    }

    wifi_scan_config_t scan_cfg = { .show_hidden = false };
    esp_err_t scan_err = ESP_ERR_WIFI_STATE;
    for (int attempt = 0; attempt <= WIFI_SCAN_STATE_RETRIES; attempt++) {
        scan_err = esp_wifi_scan_start(&scan_cfg, true); /* blocking */
        if (scan_err != ESP_ERR_WIFI_STATE) break;
        if (attempt < WIFI_SCAN_STATE_RETRIES) {
            ESP_LOGW(TAG, "Wi-Fi scan not ready; retrying (%d/%d)",
                     attempt + 1, WIFI_SCAN_STATE_RETRIES);
            vTaskDelay(pdMS_TO_TICKS(WIFI_SCAN_STATE_RETRY_MS));
        }
    }
    if (scan_err == ESP_OK) {
        uint16_t count = 0;
        esp_wifi_scan_get_ap_num(&count);
        if (count > (uint16_t)max) count = (uint16_t)max;
        if (count > 0) {
            wifi_ap_record_t *records = malloc(count * sizeof(wifi_ap_record_t));
            if (records) {
                esp_wifi_scan_get_ap_records(&count, records);
                for (int i = 0; i < count; i++) {
                    /* ssid is a fixed 33-byte field; force NUL-termination. */
                    memcpy(out[n].ssid, records[i].ssid, 32);
                    out[n].ssid[32] = '\0';
                    if (out[n].ssid[0] == '\0') continue; /* skip hidden/blank */
                    out[n].rssi = records[i].rssi;
                    out[n].authmode = (uint8_t)records[i].authmode;
                    out[n].open = (records[i].authmode == WIFI_AUTH_OPEN);
                    n++;
                }
                free(records);
            }
        }
    } else {
        ESP_LOGE(TAG, "Wi-Fi scan failed: %s", esp_err_to_name(scan_err));
    }

cleanup:
    if (scan_handler_registered) {
        esp_event_handler_instance_unregister(WIFI_EVENT, WIFI_EVENT_STA_START,
                                              scan_handler);
    }
    if (scan_events) vEventGroupDelete(scan_events);
    if (was_started) {
        esp_wifi_set_mode(prev_mode); /* keep an existing SoftAP/station alive */
    } else {
        esp_wifi_stop();
        s_wifi_started = false;
        esp_wifi_set_mode(prev_mode); /* don't strand a scan-only radio in STA */
    }
    xSemaphoreGive(s_wifi_mutex);
    return n;
}

static esp_err_t portal_scan_handler(httpd_req_t *req)
{
    wifi_ap_info_t records[20] = {0};
    int count = wifi_manager_scan(records, 20);

    /* Build JSON response with cJSON so SSIDs are escaped — a crafted nearby
     * SSID (containing quotes/backslashes/control chars) must not be able to
     * break out of the JSON string or corrupt the network list. */
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < count; i++) {
        /* wifi_ap_record_t.ssid is a fixed 33-byte field; force NUL-termination. */
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", records[i].ssid);
        cJSON_AddNumberToObject(o, "rssi", records[i].rssi);
        cJSON_AddNumberToObject(o, "auth", records[i].authmode);
        cJSON_AddItemToArray(arr, o);
    }
    char *json = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json ? json : "[]");
    if (json) cJSON_free(json);

    return ESP_OK;
}

static esp_err_t portal_redirect_handler(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://" CONFIG_VELLUM_PORTAL_IP "/");
    return httpd_resp_send(req, NULL, 0);
}

static void ensure_netif_init(void)
{
    if (!s_netif_initialized) {
        ESP_ERROR_CHECK(esp_netif_init());
        ESP_ERROR_CHECK(esp_event_loop_create_default());
        s_netif_initialized = true;
    }
}

/* ---- Public API -------------------------------------------------------- */

void wifi_manager_init(void)
{
    if (s_wifi_initialized) return;

    ensure_netif_init();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    wait_for_wifi_transport();
    s_wifi_mutex = xSemaphoreCreateMutex();
    ESP_ERROR_CHECK(s_wifi_mutex ? ESP_OK : ESP_ERR_NO_MEM);
    s_wifi_initialized = true;
}

static void ensure_sta_netif(void)
{
    if (!s_sta_netif) s_sta_netif = esp_netif_create_default_wifi_sta();
}

static void ensure_ap_netif(void)
{
    if (!s_ap_netif) s_ap_netif = esp_netif_create_default_wifi_ap();
}

void wifi_manager_get_mac(char *buf, size_t buf_len)
{
    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    snprintf(buf, buf_len, "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

void wifi_manager_get_softap_ssid(char *buf, size_t buf_len)
{
    uint8_t mac[6] = {0};
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    if (mac[0] == 0 && mac[1] == 0 && mac[2] == 0 && mac[3] == 0) {
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
    }
    snprintf(buf, buf_len, "Vellum-%02X%02X", mac[4], mac[5]);
}

int wifi_manager_get_rssi(void)
{
    wifi_ap_record_t info;
    if (esp_wifi_sta_get_ap_info(&info) == ESP_OK) {
        return info.rssi;
    }
    return 0;
}

bool wifi_manager_is_connected(void)
{
    wifi_ap_record_t info;
    return esp_wifi_sta_get_ap_info(&info) == ESP_OK;
}

const char *wifi_manager_get_last_failure_message(void)
{
    return wifi_failure_message(s_last_failure);
}

wifi_result_t wifi_manager_connect_station(void)
{
    wifi_manager_init();
    xSemaphoreTake(s_wifi_mutex, portMAX_DELAY);

    if (!nvs_manager_has_wifi_credentials()) {
        ESP_LOGI(TAG, "No stored Wi-Fi credentials");
        xSemaphoreGive(s_wifi_mutex);
        return WIFI_RESULT_NO_CREDENTIALS;
    }

    ensure_sta_netif();

    /* Serial provisioning may have connected while app_main was still drawing
     * the boot/setup screen. Treat the later app_main call as idempotent. */
    wifi_ap_record_t current_ap;
    if (esp_wifi_sta_get_ap_info(&current_ap) == ESP_OK) {
        s_credentials_received = true;
        xSemaphoreGive(s_wifi_mutex);
        return WIFI_RESULT_CONNECTED;
    }

    char ssid[NVS_MAX_SSID_LEN];
    char pass[NVS_MAX_PASS_LEN];
    if (nvs_manager_get_wifi_ssid(ssid, sizeof(ssid)) != ESP_OK ||
        nvs_manager_get_wifi_pass(pass, sizeof(pass)) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read Wi-Fi credentials from NVS");
        xSemaphoreGive(s_wifi_mutex);
        return WIFI_RESULT_FAILED;
    }

    s_wifi_event_group = xEventGroupCreate();
    s_retry_count = 0;
    s_last_disconnect_reason = 0;
    s_last_failure = WIFI_FAILURE_TIMED_OUT;

    esp_event_handler_instance_t inst_any_id, inst_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &inst_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &inst_got_ip));

    wifi_config_t wifi_config = {0};
    strlcpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, pass, sizeof(wifi_config.sta.password));
    /* Improv and the captive portal both allow an empty password for open
     * networks. Requiring WPA2 unconditionally makes those valid profiles
     * impossible to join despite advertising them as open in scan results. */
    wifi_config.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    if (pass[0]) {
        /* Scan every matching BSSID and prefer the strongest security mode.
         * A fast scan can otherwise stop at a WPA2 BSSID before discovering a
         * WPA3-capable BSSID broadcasting the same SSID. */
        wifi_config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
        wifi_config.sta.sort_method = WIFI_CONNECT_AP_BY_SECURITY;

        /* WPA3-Personal requires PMF and SAE. Keep PMF optional at the policy
         * level so the same saved profile still works with WPA2-only and
         * WPA2/WPA3 transition networks; the driver requires it automatically
         * when SAE is negotiated. Supporting both PWE derivation methods is
         * required for compatibility with older WPA3 APs and modern H2E APs. */
        wifi_config.sta.pmf_cfg.capable = true;
        wifi_config.sta.pmf_cfg.required = false;
        wifi_config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
        wifi_config.sta.sae_pk_mode = WPA3_SAE_PK_MODE_AUTOMATIC;
        wifi_config.sta.transition_disable = 0;
#if CONFIG_ESP_WIFI_WPA3_COMPATIBLE_SUPPORT
        wifi_config.sta.disable_wpa3_compatible_mode = 0;
#endif
    }

    wifi_mode_t prev_mode = WIFI_MODE_NULL;
    esp_wifi_get_mode(&prev_mode);
    bool was_started = s_wifi_started;
    wifi_mode_t connect_mode =
        (prev_mode == WIFI_MODE_AP || prev_mode == WIFI_MODE_APSTA)
            ? WIFI_MODE_APSTA : WIFI_MODE_STA;
    ESP_ERROR_CHECK(esp_wifi_set_mode(connect_mode));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    if (!s_wifi_started) {
        ESP_ERROR_CHECK(esp_wifi_start());
        s_wifi_started = true;
    }

    ESP_LOGI(TAG, "Connecting to '%s'...", ssid);

    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, pdFALSE,
        pdMS_TO_TICKS(CONFIG_VELLUM_WIFI_CONNECT_TIMEOUT_MS * CONFIG_VELLUM_WIFI_MAX_RETRIES));

    esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, inst_any_id);
    esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, inst_got_ip);
    vEventGroupDelete(s_wifi_event_group);

    if (bits & WIFI_CONNECTED_BIT) {
        /* Releases wifi_manager_start_softap(), if it is active. It will serve
         * its final response briefly and reboot into the normal station path. */
        s_credentials_received = true;
        xSemaphoreGive(s_wifi_mutex);
        return WIFI_RESULT_CONNECTED;
    }

    ESP_LOGW(TAG, "All connection attempts failed (%s)",
             wifi_manager_get_last_failure_message());
    if (was_started) {
        esp_wifi_disconnect();
        esp_wifi_set_mode(prev_mode); /* keep an existing captive portal alive */
    } else {
        esp_wifi_stop();
        s_wifi_started = false;
        esp_wifi_set_mode(prev_mode);
    }
    xSemaphoreGive(s_wifi_mutex);
    return WIFI_RESULT_FAILED;
}

/* ── Captive DNS server (resolves all queries to portal IP) ────── */
#include "lwip/sockets.h"

static void captive_dns_task(void *arg)
{
    (void)arg;
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) { vTaskDelete(NULL); return; }

    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = INADDR_ANY };
    bind(sock, (struct sockaddr *)&addr, sizeof(addr));

    /* Parse portal IP into 4 bytes */
    esp_ip4_addr_t portal_ip;
    esp_netif_str_to_ip4(CONFIG_VELLUM_PORTAL_IP, &portal_ip);
    uint8_t ip_bytes[4];
    memcpy(ip_bytes, &portal_ip.addr, 4);

    uint8_t buf[512];
    while (1) {
        struct sockaddr_in client;
        socklen_t client_len = sizeof(client);
        int len = recvfrom(sock, buf, sizeof(buf), 0, (struct sockaddr *)&client, &client_len);
        /* Reject undersized queries and any query large enough that copying it
         * plus the 16-byte answer would overflow resp[] (stack-safety). */
        if (len < 12 || len > (int)sizeof(buf) - 16) continue;

        /* Build minimal DNS response: copy header, set QR+AA flags, append A record pointing to us */
        uint8_t resp[512];
        memcpy(resp, buf, len);
        resp[2] = 0x81; resp[3] = 0x80; /* QR=1, AA=1, RCODE=0 */
        resp[6] = 0; resp[7] = 1; /* ANCOUNT=1 */

        /* Append answer: pointer to question name + A record */
        int pos = len;
        resp[pos++] = 0xC0; resp[pos++] = 0x0C; /* name pointer to offset 12 */
        resp[pos++] = 0x00; resp[pos++] = 0x01; /* TYPE A */
        resp[pos++] = 0x00; resp[pos++] = 0x01; /* CLASS IN */
        resp[pos++] = 0; resp[pos++] = 0; resp[pos++] = 0; resp[pos++] = 0x0A; /* TTL 10s */
        resp[pos++] = 0x00; resp[pos++] = 0x04; /* RDLENGTH 4 */
        memcpy(&resp[pos], ip_bytes, 4); pos += 4;

        sendto(sock, resp, pos, 0, (struct sockaddr *)&client, client_len);
    }
}

void wifi_manager_start_softap(void)
{
    wifi_manager_init();
    xSemaphoreTake(s_wifi_mutex, portMAX_DELAY);
    ensure_ap_netif();
    s_credentials_received = false;

    /* Set custom portal IP */
    esp_netif_ip_info_t ip_info = {0};
    esp_netif_str_to_ip4(CONFIG_VELLUM_PORTAL_IP, &ip_info.ip);
    esp_netif_str_to_ip4(CONFIG_VELLUM_PORTAL_IP, &ip_info.gw);
    IP4_ADDR(&ip_info.netmask, 255, 255, 255, 0);
    esp_netif_dhcps_stop(s_ap_netif);
    esp_netif_set_ip_info(s_ap_netif, &ip_info);
    esp_netif_dhcps_start(s_ap_netif);

    char ap_ssid[32];
    wifi_manager_get_softap_ssid(ap_ssid, sizeof(ap_ssid));
    ESP_LOGI(TAG, "Starting SoftAP: %s", ap_ssid);

    wifi_config_t ap_config = {
        .ap = {
            .channel = 1,
            .max_connection = 4,
            /* TRADEOFF: the onboarding SoftAP is OPEN so a first-time user can join
             * without a pre-shared password (no screen/keyboard to convey one).
             * The Wi-Fi PSK and server URL therefore transit this local AP in the
             * clear during the brief provisioning window. It is only up while the
             * device has no stored credentials, and shuts down on the first
             * successful /save + reboot. Harden later with a WPA2 AP whose per-
             * device password is shown on the e-paper screen / QR payload. */
            .authmode = WIFI_AUTH_OPEN,
        },
    };
    strlcpy((char *)ap_config.ap.ssid, ap_ssid, sizeof(ap_config.ap.ssid));
    ap_config.ap.ssid_len = strlen(ap_ssid);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    if (!s_wifi_started) {
        ESP_ERROR_CHECK(esp_wifi_start());
        s_wifi_started = true;
    }
    xSemaphoreGive(s_wifi_mutex);

    ESP_LOGI(TAG, "SoftAP started, launching captive portal");

    /* Start HTTP server for captive portal */
    httpd_config_t httpd_config = HTTPD_DEFAULT_CONFIG();
    httpd_config.uri_match_fn = httpd_uri_match_wildcard;
    httpd_handle_t server = NULL;
    ESP_ERROR_CHECK(httpd_start(&server, &httpd_config));

    const httpd_uri_t uri_root = {
        .uri = "/", .method = HTTP_GET, .handler = portal_root_handler,
    };
    const httpd_uri_t uri_save = {
        .uri = "/save", .method = HTTP_POST, .handler = portal_save_handler,
    };
    const httpd_uri_t uri_scan = {
        .uri = "/scan", .method = HTTP_GET, .handler = portal_scan_handler,
    };
    const httpd_uri_t uri_catch_all = {
        .uri = "/*", .method = HTTP_GET, .handler = portal_redirect_handler,
    };

    httpd_register_uri_handler(server, &uri_root);
    httpd_register_uri_handler(server, &uri_save);
    httpd_register_uri_handler(server, &uri_scan);
    httpd_register_uri_handler(server, &uri_catch_all);

    /* Start captive DNS — resolves ALL queries to our IP (triggers iOS/Android popup) */
    xTaskCreate(captive_dns_task, "dns", 4096, NULL, 5, NULL);

    /* Block until credentials are submitted */
    while (!s_credentials_received) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    /* Brief delay so the success page can be served */
    vTaskDelay(pdMS_TO_TICKS(2000));

    httpd_stop(server);
    ESP_LOGI(TAG, "Credentials saved, restarting...");
    esp_restart();
}
