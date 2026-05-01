// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file main.c
 * @brief Vellum D1001 firmware — always-on LCD display client
 *
 * Unlike E-series (deep sleep between refreshes), the D1001 LCD is always on.
 * Main loop: connect WiFi → register with server → poll for content → display.
 */

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "nvs_flash.h"
#include "esp_netif.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "cJSON.h"
#include "vellum_lcd.h"

static const char *TAG = "vellum-d1001";

#define SERVER_URL      CONFIG_VELLUM_SERVER_URL
#define POLL_INTERVAL_S 60  /* Refresh content every 60s (LCD is always on) */
#define MAX_JPEG_SIZE   (512 * 1024)  /* 512KB max JPEG */

static char s_mac[13] = {0};
static char s_token[65] = {0};
static uint8_t *s_jpeg_buf = NULL;

/* ── WiFi ─────────────────────────────────────────────────────── */
/* On ESP32-P4, WiFi is handled by the ESP32-C6 co-processor via
 * esp_wifi_remote. The actual implementation requires the Seeed BSP
 * which configures the SPI link between P4 and C6.
 * TODO: Integrate Seeed D1001 BSP for WiFi co-processor support.
 */

static bool s_wifi_connected = false;

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    /* WiFi via ESP32-C6 co-processor — requires Seeed BSP integration */
    ESP_LOGW(TAG, "WiFi stub — real implementation needs Seeed D1001 BSP");
    /* For now, assume WiFi will be connected after BSP init */
    s_wifi_connected = true;
}

/* ── HTTP helpers ─────────────────────────────────────────────── */

static void get_mac_string(void)
{
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_mac, sizeof(s_mac), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static bool perform_hello(void)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/ink/hello", SERVER_URL);

    cJSON *body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "mac", s_mac);
    cJSON *display = cJSON_AddObjectToObject(body, "display");
    cJSON_AddStringToObject(display, "model", "d1001");
    cJSON_AddNumberToObject(display, "width", 800);
    cJSON_AddNumberToObject(display, "height", 1280);
    cJSON_AddStringToObject(display, "quantize", "jpeg");
    cJSON *palette = cJSON_AddArrayToObject(display, "palette");
    /* Full color — empty palette signals "any color" */
    (void)palette;

    char *json = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);

    esp_http_client_config_t config = { .url = url, .method = HTTP_METHOD_POST };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, json, strlen(json));

    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);

    if (err == ESP_OK && status == 200) {
        /* Parse token from response */
        int len = esp_http_client_get_content_length(client);
        if (len > 0 && len < 1024) {
            char *resp = malloc(len + 1);
            esp_http_client_read(client, resp, len);
            resp[len] = 0;
            cJSON *r = cJSON_Parse(resp);
            if (r) {
                const char *tok = cJSON_GetStringValue(cJSON_GetObjectItem(r, "token"));
                if (tok) strncpy(s_token, tok, sizeof(s_token) - 1);
                cJSON_Delete(r);
            }
            free(resp);
        }
    }

    esp_http_client_cleanup(client);
    free(json);

    return s_token[0] != 0;
}

static int fetch_content(void)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/ink/render?mac=%s", SERVER_URL, s_mac);

    esp_http_client_config_t config = { .url = url, .method = HTTP_METHOD_GET, .buffer_size = 4096 };
    esp_http_client_handle_t client = esp_http_client_init(&config);

    char auth[80];
    snprintf(auth, sizeof(auth), "Bearer %s", s_token);
    esp_http_client_set_header(client, "Authorization", auth);

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return -1;
    }

    int content_length = esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    if (status == 304) {
        /* Content unchanged */
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return 0;
    }

    if (status != 200 || content_length <= 0 || content_length > MAX_JPEG_SIZE) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return -1;
    }

    int read = esp_http_client_read(client, (char *)s_jpeg_buf, content_length);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);

    if (read != content_length) return -1;

    /* Display the JPEG */
    esp_err_t ret = vellum_lcd_show_jpeg(s_jpeg_buf, read);
    return ret == ESP_OK ? 1 : -1;
}

/* ── Main ─────────────────────────────────────────────────────── */

void app_main(void)
{
    ESP_LOGI(TAG, "Vellum D1001 starting...");

    /* Init NVS */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    /* Init LCD */
    ESP_ERROR_CHECK(vellum_lcd_init());

    /* Get MAC */
    get_mac_string();
    ESP_LOGI(TAG, "MAC: %s", s_mac);

    /* Allocate JPEG buffer in PSRAM */
    s_jpeg_buf = heap_caps_malloc(MAX_JPEG_SIZE, MALLOC_CAP_SPIRAM);
    assert(s_jpeg_buf);

    /* Init WiFi */
    wifi_init();

    /* Wait for WiFi */
    while (!s_wifi_connected) {
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    /* Register with server */
    for (int i = 0; i < 5; i++) {
        if (perform_hello()) break;
        vTaskDelay(pdMS_TO_TICKS(3000));
    }

    if (!s_token[0]) {
        ESP_LOGE(TAG, "Failed to register with server");
    }

    /* Main loop — always on, periodic refresh */
    while (1) {
        if (s_wifi_connected && s_token[0]) {
            int result = fetch_content();
            if (result > 0) ESP_LOGI(TAG, "Content updated");
            else if (result == 0) ESP_LOGD(TAG, "Content unchanged");
            else ESP_LOGW(TAG, "Content fetch failed");
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_S * 1000));
    }
}
