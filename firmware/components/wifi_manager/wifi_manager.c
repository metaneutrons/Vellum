// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file wifi_manager.c
 * @brief ESP-IDF Wi-Fi station + SoftAP captive portal implementation.
 */

#include "wifi_manager.h"
#include "nvs_manager.h"

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
    "<input type=\"text\" name=\"server\" maxlength=\"200\" placeholder=\"Leave empty for auto-discovery\">"
    "<div class=\"hint\">Optional. The display will find the server automatically via mDNS.</div></div>"
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
/* WiFi scan endpoint — returns JSON array of networks */
static esp_err_t portal_scan_handler(httpd_req_t *req)
{
    /* Switch to APSTA mode for scanning */
    esp_wifi_set_mode(WIFI_MODE_APSTA);

    wifi_scan_config_t scan_cfg = { .show_hidden = false };
    esp_wifi_scan_start(&scan_cfg, true); /* blocking scan */

    uint16_t count = 0;
    esp_wifi_scan_get_ap_num(&count);
    if (count > 20) count = 20;

    wifi_ap_record_t *records = malloc(count * sizeof(wifi_ap_record_t));
    if (!records) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }
    esp_wifi_scan_get_ap_records(&count, records);

    /* Build JSON response */
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr_chunk(req, "[");
    for (int i = 0; i < count; i++) {
        char entry[128];
        snprintf(entry, sizeof(entry), "%s{\"ssid\":\"%s\",\"rssi\":%d,\"auth\":%d}",
                 i > 0 ? "," : "", records[i].ssid, records[i].rssi, records[i].authmode);
        httpd_resp_sendstr_chunk(req, entry);
    }
    httpd_resp_sendstr_chunk(req, "]");
    httpd_resp_sendstr_chunk(req, NULL);

    free(records);
    esp_wifi_set_mode(WIFI_MODE_AP); /* back to AP only */
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
    strlcpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, pass, sizeof(wifi_config.sta.password));
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
        if (len < 12) continue;

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
    char ap_ssid[32];
    wifi_manager_get_softap_ssid(ap_ssid, sizeof(ap_ssid));
    ESP_LOGI(TAG, "Starting SoftAP: %s", ap_ssid);

    ensure_netif_init();
    esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();

    /* Set custom portal IP */
    esp_netif_ip_info_t ip_info = {0};
    esp_netif_str_to_ip4(CONFIG_VELLUM_PORTAL_IP, &ip_info.ip);
    esp_netif_str_to_ip4(CONFIG_VELLUM_PORTAL_IP, &ip_info.gw);
    IP4_ADDR(&ip_info.netmask, 255, 255, 255, 0);
    esp_netif_dhcps_stop(ap_netif);
    esp_netif_set_ip_info(ap_netif, &ip_info);
    esp_netif_dhcps_start(ap_netif);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    wifi_config_t ap_config = {
        .ap = {
            .channel = 1,
            .max_connection = 4,
            .authmode = WIFI_AUTH_OPEN,
        },
    };
    strlcpy((char *)ap_config.ap.ssid, ap_ssid, sizeof(ap_config.ap.ssid));
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
