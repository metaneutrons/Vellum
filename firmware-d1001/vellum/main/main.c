// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file main.c
 * @brief Vellum D1001 firmware — always-on 8" LCD display client
 *
 * ESP32-P4 + ESP32-C6 (WiFi via SDIO/esp_hosted)
 * 800×1280 MIPI-DSI LCD with JD9365 controller
 * Uses Seeed BSP for hardware abstraction
 */

#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "nvs_flash.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "esp_mac.h"
#include "esp_sleep.h"
#include "cJSON.h"
#include "bsp_lsm6ds3.h"
#include "lvgl.h"
#include "jpeg_decoder.h"
#include "esp-bsp.h"
#include "vellum_logo_img.h"
#include "display.h"

static const char *TAG = "vellum_d1001";

#define WIFI_SSID      "Schmieder24"
#define WIFI_PASS      "oberon2017"
#define SERVER_URL     "http://192.168.16.5:3000"

#define LCD_WIDTH      800
#define LCD_HEIGHT     1280

static bool s_wifi_connected = false;
static lv_display_t *s_display = NULL;

static void display_show_status(const char *text);

/* ─── Orientation ──────────────────────────────────────────────────────── */

static const char *detect_orientation(void)
{
    extern lsm6ds3_handle_t lsm6ds3;
    float x, y, z;
    if (bsp_lsm6ds3_read_accel(&lsm6ds3, &x, &y, &z) != ESP_OK) {
        return "portrait"; /* fallback */
    }
    /* If |x| > |y|, device is landscape (gravity along short axis) */
    return (fabsf(x) > fabsf(y)) ? "landscape" : "portrait";
}

/* ─── WiFi ─────────────────────────────────────────────────────────────── */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_wifi_connected = false;
        ESP_LOGW(TAG, "WiFi disconnected — reconnecting");
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "WiFi connected: " IPSTR, IP2STR(&event->ip_info.ip));
        s_wifi_connected = true;
    }
}

static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = WIFI_SSID,
            .password = WIFI_PASS,
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
}

/* ─── Display ──────────────────────────────────────────────────────────── */

static void display_init(void)
{
    bsp_display_cfg_t cfg = {
        .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
        .buffer_size = LCD_WIDTH * LCD_HEIGHT,
        .double_buffer = false,
        .flags = {
            .buff_dma = false,
            .buff_spiram = true,
            .sw_rotate = false,
        }
    };
    s_display = bsp_display_start_with_config(&cfg);
    if (!s_display) {
        ESP_LOGE(TAG, "Display init failed!");
        return;
    }

    vTaskDelay(pdMS_TO_TICKS(100));
    bsp_display_backlight_on();

    /* Boot screen */
    display_show_status("v1.0.0 | D1001");
    ESP_LOGI(TAG, "Display initialized: %dx%d", LCD_WIDTH, LCD_HEIGHT);
}

static lv_color_t *s_logo_buf = NULL;

static void draw_logo(lv_obj_t *parent)
{
    if (!s_logo_buf) {
        s_logo_buf = heap_caps_malloc(VELLUM_LOGO_W * VELLUM_LOGO_H * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
    }
    if (!s_logo_buf) return;

    lv_obj_t *canvas = lv_canvas_create(parent);
    lv_canvas_set_buffer(canvas, s_logo_buf, VELLUM_LOGO_W, VELLUM_LOGO_H, LV_COLOR_FORMAT_NATIVE);
    lv_canvas_fill_bg(canvas, lv_color_white(), LV_OPA_COVER);
    for (int y = 0; y < VELLUM_LOGO_H; y++) {
        for (int x = 0; x < VELLUM_LOGO_W; x++) {
            int byte_idx = y * VELLUM_LOGO_STRIDE + (x / 8);
            int bit_idx = 7 - (x % 8);
            if (vellum_logo_bits[byte_idx] & (1 << bit_idx)) {
                lv_canvas_set_px(canvas, x, y, lv_color_black(), LV_OPA_COVER);
            }
        }
    }
    lv_obj_align(canvas, LV_ALIGN_TOP_MID, 0, (LCD_HEIGHT / 2) - VELLUM_LOGO_H - 40);
}

static void display_show_status(const char *text)
{
    bsp_display_lock(0);
    lv_obj_t *scr = lv_disp_get_scr_act(NULL);
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    draw_logo(scr);

    lv_obj_t *label = lv_label_create(scr);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(label, lv_color_make(80, 80, 80), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(label, LV_ALIGN_CENTER, 0, VELLUM_LOGO_H / 2);
    bsp_display_unlock();
}

/* ─── HTTP Content Fetch ───────────────────────────────────────────────── */

static uint8_t *s_img_buf = NULL;
static int s_img_len = 0;

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA) {
        if (s_img_buf && (s_img_len + evt->data_len) <= (LCD_WIDTH * LCD_HEIGHT * 2)) {
            memcpy(s_img_buf + s_img_len, evt->data, evt->data_len);
            s_img_len += evt->data_len;
        }
    }
    return ESP_OK;
}

static char s_token[128] = "0008e1be5a965ef8fc8c26826d779442d9391d6dbe04ad55f283ee6ca3e80dd5";

static bool perform_hello(const char *mac_str)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/ink/hello", SERVER_URL);

    char body[512];
    const char *orient = detect_orientation();
    snprintf(body, sizeof(body),
        "{\"mac\":\"%s\",\"display\":{\"model\":\"D1001\",\"width\":%d,\"height\":%d,"
        "\"quantize\":\"jpeg\",\"palette\":[[0,0,0],[255,255,255],[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,128,0]],"
        "\"orientations\":[\"portrait\",\"landscape\"],\"orientation\":\"%s\"}}",
        mac_str, LCD_WIDTH, LCD_HEIGHT, orient);

    /* Ensure buffer exists for response capture */
    if (!s_img_buf) {
        s_img_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    }
    s_img_len = 0;

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        .event_handler = http_event_handler,
        .transport_type = HTTP_TRANSPORT_OVER_TCP,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));

    ESP_LOGI(TAG, "Sending hello POST to %s (body=%d bytes)", url, (int)strlen(body));
    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    ESP_LOGI(TAG, "POST /hello → %d (%d bytes body)", status, s_img_len);

    if (err == ESP_OK && status == 200 && s_img_len > 0) {
        s_img_buf[s_img_len] = '\0';
        cJSON *root = cJSON_Parse((char *)s_img_buf);
        if (root) {
            cJSON *data = cJSON_GetObjectItem(root, "data");
            if (data) {
                cJSON *token = cJSON_GetObjectItem(data, "token");
                if (cJSON_IsString(token)) {
                    strncpy(s_token, token->valuestring, sizeof(s_token) - 1);
                    ESP_LOGI(TAG, "Got token: %.8s...", s_token);
                }
                cJSON *st = cJSON_GetObjectItem(data, "status");
                if (cJSON_IsString(st)) {
                    ESP_LOGI(TAG, "Hello status: %s", st->valuestring);
                }
            }
            cJSON_Delete(root);
        }
    }
    s_img_len = 0;
    return strlen(s_token) > 0;
}

static uint32_t s_sleep_duration = 60;
static bool s_sleep_deep = false;

static bool fetch_and_display(const char *mac_str)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/ink/render?mac=%s", SERVER_URL, mac_str);

    s_img_len = 0;
    if (!s_img_buf) {
        s_img_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
        if (!s_img_buf) {
            ESP_LOGE(TAG, "Failed to allocate image buffer");
            return false;
        }
    }

    esp_http_client_config_t config = {
        .url = url,
        .event_handler = http_event_handler,
        .timeout_ms = 30000,
        .buffer_size = 16384,
        .buffer_size_tx = 4096,
        .transport_type = HTTP_TRANSPORT_OVER_TCP,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (strlen(s_token) > 0) {
        esp_http_client_set_header(client, "x-device-token", s_token);
    }
    /* Telemetry headers */
    char buf[16];
    snprintf(buf, sizeof(buf), "%d", bsp_battery_percent_read());
    esp_http_client_set_header(client, "X-Battery-Level", buf);
    snprintf(buf, sizeof(buf), "%d", bsp_battery_voltage_read());
    esp_http_client_set_header(client, "X-Battery-Voltage", buf);
    esp_http_client_set_header(client, "X-Power-Source", bsp_usb_voltage_read() > 4000 ? "usb" : "battery");
    esp_http_client_set_header(client, "X-Display-Model", "D1001");
    ESP_LOGI(TAG, "Fetching render...");

    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);

    /* Capture sleep headers */
    char *hdr_val = NULL;
    if (esp_http_client_get_header(client, "X-Sleep-Duration", &hdr_val) == ESP_OK && hdr_val) {
        s_sleep_duration = (uint32_t)atoi(hdr_val);
    }
    char *mode_val = NULL;
    if (esp_http_client_get_header(client, "X-Sleep-Mode", &mode_val) == ESP_OK && mode_val) {
        s_sleep_deep = (strcmp(mode_val, "sleep") == 0);
    }

    esp_http_client_cleanup(client);

    if (err != ESP_OK || status != 200) {
        ESP_LOGW(TAG, "HTTP failed: err=%s status=%d", esp_err_to_name(err), status);
        return false;
    }

    ESP_LOGI(TAG, "Received %d bytes from server", s_img_len);

    /* Decode JPEG to RGB565 using software decoder */
    uint8_t *rgb_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!rgb_buf) {
        ESP_LOGE(TAG, "Failed to allocate RGB buffer");
        return false;
    }

    esp_jpeg_image_cfg_t jpeg_cfg = {
        .indata = s_img_buf,
        .indata_size = s_img_len,
        .outbuf = rgb_buf,
        .outbuf_size = LCD_WIDTH * LCD_HEIGHT * 2,
        .out_format = JPEG_IMAGE_FORMAT_RGB565,
        .out_scale = JPEG_IMAGE_SCALE_0,
    };
    esp_jpeg_image_output_t out_info;
    esp_err_t dec_err = esp_jpeg_decode(&jpeg_cfg, &out_info);
    if (dec_err != ESP_OK) {
        ESP_LOGE(TAG, "JPEG decode failed: %s", esp_err_to_name(dec_err));
        free(rgb_buf);
        return false;
    }
    ESP_LOGI(TAG, "JPEG decoded: %dx%d", out_info.width, out_info.height);

    /* Rotate 90° CW if image is landscape but panel is portrait */
    uint16_t disp_w = out_info.width;
    uint16_t disp_h = out_info.height;
    if (out_info.width > out_info.height && LCD_HEIGHT > LCD_WIDTH) {
        ESP_LOGI(TAG, "Rotating 90° CW for portrait panel");
        uint16_t *src = (uint16_t *)rgb_buf;
        uint16_t *dst = heap_caps_malloc(out_info.width * out_info.height * 2, MALLOC_CAP_SPIRAM);
        if (dst) {
            for (int y = 0; y < out_info.height; y++) {
                for (int x = 0; x < out_info.width; x++) {
                    dst[x * out_info.height + (out_info.height - 1 - y)] = src[y * out_info.width + x];
                }
            }
            free(rgb_buf);
            rgb_buf = (uint8_t *)dst;
            disp_w = out_info.height;
            disp_h = out_info.width;
        }
    }

    /* Display decoded image via LVGL */
    bsp_display_lock(0);
    lv_obj_t *scr = lv_disp_get_scr_act(NULL);
    lv_obj_clean(scr);

    lv_obj_t *img = lv_img_create(scr);
    static lv_img_dsc_t img_dsc;
    memset(&img_dsc, 0, sizeof(img_dsc));
    img_dsc.header.w = disp_w;
    img_dsc.header.h = disp_h;
    img_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    img_dsc.data_size = disp_w * disp_h * 2;
    img_dsc.data = rgb_buf;
    lv_img_set_src(img, &img_dsc);
    lv_obj_align(img, LV_ALIGN_TOP_LEFT, 0, 0);

    bsp_display_unlock();
    /* Note: rgb_buf must stay alive while displayed — don't free it */
    return true;
}

/* ─── Main ─────────────────────────────────────────────────────────────── */

void app_main(void)
{
    ESP_LOGI(TAG, "===== Vellum D1001 Firmware =====");

    /* Power init (holds power rail) */
    bsp_power_init();

    /* NVS */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    /* Display first — show boot screen immediately */
    display_init();

    /* WiFi (SDIO to C6 — may take a few seconds) */
    display_show_status("Connecting...");
    wifi_init();

    /* Wait for WiFi */
    for (int i = 0; i < 100 && !s_wifi_connected; i++) {
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    if (!s_wifi_connected) {
        display_show_status("WiFi failed!");
        ESP_LOGE(TAG, "WiFi connection timeout");
        return;
    }

    /* Get MAC for device identification */
    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    char mac_str[13];
    snprintf(mac_str, sizeof(mac_str), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    ESP_LOGI(TAG, "MAC: %s", mac_str);

    display_show_status("Connected!\nRegistering...");

    /* Small delay so serial monitor can catch up */
    vTaskDelay(pdMS_TO_TICKS(2000));

    /* Test connectivity */
    ESP_LOGI(TAG, "Testing connection to %s...", SERVER_URL);

    /* Register with server — retry until we get a token */
    for (int i = 0; i < 5 && strlen(s_token) == 0; i++) {
        perform_hello(mac_str);
        if (strlen(s_token) == 0) {
            ESP_LOGW(TAG, "No token yet (attempt %d) — waiting 5s", i + 1);
            vTaskDelay(pdMS_TO_TICKS(5000));
        }
    }

    if (strlen(s_token) > 0) {
        ESP_LOGI(TAG, "Authenticated — starting content loop");
    } else {
        ESP_LOGE(TAG, "Failed to get token after 5 attempts");
    }

    display_show_status("Fetching content...");

    /* Main loop — server controls refresh interval and sleep mode */
    while (1) {
        if (s_wifi_connected) {
            if (fetch_and_display(mac_str)) {
                ESP_LOGI(TAG, "Display updated");
            }
        }

        ESP_LOGI(TAG, "Next: %s for %lus", s_sleep_deep ? "DEEP SLEEP" : "poll", (unsigned long)s_sleep_duration);

        if (s_sleep_deep) {
            /* Deep sleep — display off, full power down */
            ESP_LOGI(TAG, "Entering deep sleep...");
            bsp_display_backlight_off();
            esp_sleep_enable_ext1_wakeup(1ULL << GPIO_NUM_3, ESP_EXT1_WAKEUP_ALL_LOW);
            esp_deep_sleep(s_sleep_duration * 1000000ULL);
            /* does not return */
        }

        /* Poll mode — stay awake, refresh after interval */
        vTaskDelay(pdMS_TO_TICKS(s_sleep_duration * 1000));
    }
}
