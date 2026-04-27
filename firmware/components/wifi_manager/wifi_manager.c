// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file wifi_manager.c
 * @brief ESP-IDF Wi-Fi station + SoftAP captive portal implementation.
 */

#include "wifi_manager.h"
#include "nvs_manager.h"

#include <string.h>
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

static const char *TAG = "wifi_mgr";

/* Event group bits */
#define WIFI_CONNECTED_BIT  BIT0
#define WIFI_FAIL_BIT       BIT1

static EventGroupHandle_t s_wifi_event_group;
static int s_retry_count = 0;
static bool s_netif_initialized = false;
static volatile bool s_credentials_received = false;

/* ---- Captive portal HTML (embedded) ------------------------------------ */

static const char PORTAL_HTML[] =
    "<!DOCTYPE html><html lang=\"en\"><head>"
    "<meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum Setup</title>"
    "<style>"
    "*{margin:0;padding:0;box-sizing:border-box}"
    "body{font-family:-apple-system,system-ui,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}"
    ".card{width:100%;max-width:380px;padding:32px}"
    ".logo{text-align:center;margin-bottom:24px;font-size:28px;font-weight:700;letter-spacing:-0.5px}"
    ".logo span{color:#3b82f6}"
    "h2{font-size:16px;color:#94a3b8;font-weight:400;text-align:center;margin-bottom:24px}"
    ".form-card{background:#1c1f2e;border:1px solid #2a2d3e;border-radius:12px;overflow:hidden}"
    ".field{padding:14px 18px;border-bottom:1px solid #2a2d3e}"
    ".field:last-child{border-bottom:none}"
    ".field label{display:block;font-size:11px;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px}"
    ".field input{width:100%;background:transparent;border:none;color:#e2e8f0;font-size:15px;outline:none}"
    ".field input::placeholder{color:#374151}"
    ".hint{font-size:10px;color:#475569;margin-top:4px}"
    "button{width:100%;margin-top:16px;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer}"
    "button:hover{background:#2563eb}"
    ".footer{text-align:center;margin-top:20px;font-size:11px;color:#1e293b}"
    "</style></head><body>"
    "<div class=\"card\">"
    "<div class=\"logo\">V<span>ellum</span></div>"
    "<h2>Connect your display to WiFi</h2>"
    "<form method=\"POST\" action=\"/save\">"
    "<div class=\"form-card\">"
    "<div class=\"field\"><label>WiFi Network</label>"
    "<input type=\"text\" name=\"ssid\" maxlength=\"32\" required autofocus placeholder=\"Network name\"></div>"
    "<div class=\"field\"><label>Password</label>"
    "<input type=\"password\" name=\"pass\" maxlength=\"64\" placeholder=\"WiFi password\"></div>"
    "<div class=\"field\"><label>Server URL</label>"
    "<input type=\"text\" name=\"server\" maxlength=\"200\" placeholder=\"Leave empty for auto-discovery\">"
    "<div class=\"hint\">Optional. The display will find the server automatically via mDNS.</div></div>"
    "</div>"
    "<button type=\"submit\">Connect</button>"
    "</form>"
    "<div class=\"footer\">E-Ink Display Management</div>"
    "</div></body></html>";

static const char PORTAL_SUCCESS_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>"
    "body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}"
    ".ok{font-size:48px;margin-bottom:16px}"
    "h1{color:#22c55e;font-size:20px;margin-bottom:8px}"
    "p{color:#94a3b8;font-size:14px}"
    "</style></head><body><div>"
    "<div class=\"ok\">\xe2\x9c\x93</div>"
    "<h1>Connected</h1>"
    "<p>The display will restart and connect to your network.</p>"
    "</div></body></html>";

static const char PORTAL_ERROR_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>"
    "body{font-family:-apple-system,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center}"
    "h1{color:#ef4444;font-size:20px;margin-bottom:8px}"
    "p{color:#94a3b8;font-size:14px}"
    "a{color:#3b82f6}"
    "</style></head><body><div>"
    "<h1>Invalid Input</h1>"
    "<p>Network name is required. <a href=\"/\">Try again</a>.</p>"
    "</div></body></html>";

/* ---- Wi-Fi event handler ----------------------------------------------- */

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
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
    char buf[256];
    int received = httpd_req_recv(req, buf, sizeof(buf) - 1);
    if (received <= 0) {
        httpd_resp_set_status(req, "400 Bad Request");
        return httpd_resp_send(req, PORTAL_ERROR_HTML, HTTPD_RESP_USE_STRLEN);
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
static esp_err_t portal_redirect_handler(httpd_req_t *req)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
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

void wifi_manager_get_mac(char *buf, size_t buf_len)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(buf, buf_len, "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

void wifi_manager_get_softap_ssid(char *buf, size_t buf_len)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
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

wifi_result_t wifi_manager_connect_station(void)
{
    if (!nvs_manager_has_wifi_credentials()) {
        ESP_LOGI(TAG, "No stored Wi-Fi credentials");
        return WIFI_RESULT_NO_CREDENTIALS;
    }

    char ssid[NVS_MAX_SSID_LEN];
    char pass[NVS_MAX_PASS_LEN];
    if (nvs_manager_get_wifi_ssid(ssid, sizeof(ssid)) != ESP_OK ||
        nvs_manager_get_wifi_pass(pass, sizeof(pass)) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read Wi-Fi credentials from NVS");
        return WIFI_RESULT_FAILED;
    }

    ensure_netif_init();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    s_wifi_event_group = xEventGroupCreate();
    s_retry_count = 0;

    esp_event_handler_instance_t inst_any_id, inst_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &inst_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &inst_got_ip));

    wifi_config_t wifi_config = {0};
    strncpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, pass, sizeof(wifi_config.sta.password) - 1);
    wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Connecting to '%s'...", ssid);

    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE, pdFALSE,
        pdMS_TO_TICKS(CONFIG_VELLUM_WIFI_CONNECT_TIMEOUT_MS * CONFIG_VELLUM_WIFI_MAX_RETRIES));

    esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, inst_any_id);
    esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, inst_got_ip);
    vEventGroupDelete(s_wifi_event_group);

    if (bits & WIFI_CONNECTED_BIT) {
        return WIFI_RESULT_CONNECTED;
    }

    ESP_LOGW(TAG, "All connection attempts failed");
    esp_wifi_stop();
    return WIFI_RESULT_FAILED;
}

void wifi_manager_start_softap(void)
{
    char ap_ssid[32];
    wifi_manager_get_softap_ssid(ap_ssid, sizeof(ap_ssid));
    ESP_LOGI(TAG, "Starting SoftAP: %s", ap_ssid);

    ensure_netif_init();
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    wifi_config_t ap_config = {
        .ap = {
            .channel = 1,
            .max_connection = 4,
            .authmode = WIFI_AUTH_OPEN,
        },
    };
    strncpy((char *)ap_config.ap.ssid, ap_ssid, sizeof(ap_config.ap.ssid) - 1);
    ap_config.ap.ssid_len = strlen(ap_ssid);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap_config));
    ESP_ERROR_CHECK(esp_wifi_start());

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
    const httpd_uri_t uri_catch_all = {
        .uri = "/*", .method = HTTP_GET, .handler = portal_redirect_handler,
    };

    httpd_register_uri_handler(server, &uri_root);
    httpd_register_uri_handler(server, &uri_save);
    httpd_register_uri_handler(server, &uri_catch_all);

    /* Block until credentials are submitted */
    s_credentials_received = false;
    while (!s_credentials_received) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }

    /* Brief delay so the success page can be served */
    vTaskDelay(pdMS_TO_TICKS(2000));

    httpd_stop(server);
    ESP_LOGI(TAG, "Credentials saved, restarting...");
    esp_restart();
}
