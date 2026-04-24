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
    "body{font-family:-apple-system,sans-serif;max-width:400px;margin:40px auto;padding:0 20px;background:#f5f5f5}"
    "h1{font-size:1.4em;color:#333}"
    "form{background:#fff;padding:24px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1)}"
    "label{display:block;margin-top:16px;font-size:.9em;color:#555}"
    "input{width:100%;padding:10px;margin-top:4px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:1em}"
    "button{width:100%;margin-top:20px;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:4px;font-size:1em;cursor:pointer}"
    "</style></head><body>"
    "<h1>Vellum Wi-Fi Setup</h1>"
    "<form method=\"POST\" action=\"/save\">"
    "<label for=\"ssid\">Network Name (SSID)</label>"
    "<input type=\"text\" id=\"ssid\" name=\"ssid\" maxlength=\"32\" required autofocus>"
    "<label for=\"pass\">Password</label>"
    "<input type=\"password\" id=\"pass\" name=\"pass\" maxlength=\"64\">"
    "<button type=\"submit\">Connect</button>"
    "</form></body></html>";

static const char PORTAL_SUCCESS_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>body{font-family:-apple-system,sans-serif;max-width:400px;margin:40px auto;padding:0 20px;text-align:center}"
    "h1{color:#16a34a}</style></head><body>"
    "<h1>Credentials Saved</h1><p>The device will now restart and connect to your network.</p></body></html>";

static const char PORTAL_ERROR_HTML[] =
    "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Vellum</title><style>body{font-family:-apple-system,sans-serif;max-width:400px;margin:40px auto;padding:0 20px}"
    ".error{color:#dc2626}</style></head><body>"
    "<h1 class=\"error\">Invalid Input</h1><p>SSID is required. <a href=\"/\">Try again</a>.</p></body></html>";

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

    parse_form_field(buf, "ssid", ssid, sizeof(ssid));
    parse_form_field(buf, "pass", pass, sizeof(pass));

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
