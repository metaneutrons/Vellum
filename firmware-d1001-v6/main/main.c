// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file main.c
 * @brief Vellum D1001 firmware (ESP-IDF v6.0)
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
#include "esp_timer.h"
#include "cJSON.h"
#include "lvgl.h"
#include "esp_lcd_mipi_dsi.h"
#include "jpeg_decoder.h"
#include "d1001_board.h"
#include "lcd_jd9365.h"
#include "vellum_logo_img.h"

static const char *TAG = "vellum_d1001";

#define WIFI_SSID      "Schmieder24"
#define WIFI_PASS      "oberon2017"
#define SERVER_URL     "http://192.168.16.5:3000"
#define LCD_WIDTH      800
#define LCD_HEIGHT     1280

static bool s_wifi_connected = false;
static lv_display_t *s_display = NULL;
static char s_token[128] = "0008e1be5a965ef8fc8c26826d779442d9391d6dbe04ad55f283ee6ca3e80dd5";
static uint32_t s_sleep_duration = 60;
static bool s_sleep_deep = false;

/* ─── WiFi ─────────────────────────────────────────────────────────────── */

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_wifi_connected = false;
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
    wifi_config_t wifi_config = { .sta = { .ssid = WIFI_SSID, .password = WIFI_PASS } };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
}

/* ─── Display ──────────────────────────────────────────────────────────── */

static lv_color_t *s_logo_buf = NULL;

static void draw_logo(lv_obj_t *parent)
{
    if (!s_logo_buf)
        s_logo_buf = heap_caps_malloc(VELLUM_LOGO_W * VELLUM_LOGO_H * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
    if (!s_logo_buf) return;
    lv_obj_t *canvas = lv_canvas_create(parent);
    lv_canvas_set_buffer(canvas, s_logo_buf, VELLUM_LOGO_W, VELLUM_LOGO_H, LV_COLOR_FORMAT_NATIVE);
    lv_canvas_fill_bg(canvas, lv_color_white(), LV_OPA_COVER);
    for (int y = 0; y < VELLUM_LOGO_H; y++) {
        for (int x = 0; x < VELLUM_LOGO_W; x++) {
            int byte_idx = y * VELLUM_LOGO_STRIDE + (x / 8);
            int bit_idx = 7 - (x % 8);
            if (vellum_logo_bits[byte_idx] & (1 << bit_idx))
                lv_canvas_set_px(canvas, x, y, lv_color_black(), LV_OPA_COVER);
        }
    }
    lv_obj_align(canvas, LV_ALIGN_TOP_MID, 0, (LCD_HEIGHT / 2) - VELLUM_LOGO_H - 40);
}

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    lv_display_flush_ready(disp);
}

static void lvgl_tick_task(void *arg)
{
    (void)arg;
    while (1) {
        lv_tick_inc(10);
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void display_show_status(const char *text);

static void display_init(void)
{
    lcd_jd9365_config_t lcd_cfg = {
        .lane_num = D1001_DSI_LANE_NUM,
        .lane_mbps = D1001_DSI_LANE_MBPS,
        .phy_ldo_chan = D1001_DSI_PHY_LDO_CHAN,
        .phy_ldo_mv = D1001_DSI_PHY_LDO_MV,
        .h_res = D1001_LCD_H_RES,
        .v_res = D1001_LCD_V_RES,
        .hsync = D1001_LCD_HSYNC, .hbp = D1001_LCD_HBP, .hfp = D1001_LCD_HFP,
        .vsync = D1001_LCD_VSYNC, .vbp = D1001_LCD_VBP, .vfp = D1001_LCD_VFP,
        .num_fb = 2,
        .io_expander = d1001_io_expander(),
        .rst_mask = D1001_EXP_LCD_RST,
    };
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_io_handle_t io = NULL;
    ESP_ERROR_CHECK(lcd_jd9365_init(&lcd_cfg, &panel, &io));

    /* LVGL init — use DPI panel framebuffers directly */
    lv_init();

    void *buf1 = NULL, *buf2 = NULL;
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_get_frame_buffer(panel, 2, &buf1, &buf2));

    s_display = lv_display_create(LCD_WIDTH, LCD_HEIGHT);
    lv_display_set_buffers(s_display, buf1, buf2, LCD_WIDTH * LCD_HEIGHT * 2, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(s_display, flush_cb);

    vTaskDelay(pdMS_TO_TICKS(100));
    d1001_backlight_on();
    display_show_status("v1.0.0 | D1001");
    lv_refr_now(s_display);
    ESP_LOGI(TAG, "Display initialized: %dx%d", LCD_WIDTH, LCD_HEIGHT);

    /* LVGL tick + timer task */
    xTaskCreate(lvgl_tick_task, "lvgl", 8192, NULL, 5, NULL);
}

static void display_show_status(const char *text)
{
    
    lv_obj_t *scr = lv_display_get_screen_active(s_display);
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    lv_obj_t *label = lv_label_create(scr);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(label, lv_color_white(), 0);
    lv_obj_center(label);
    
}

/* ─── HTTP ─────────────────────────────────────────────────────────────── */

static uint8_t *s_img_buf = NULL;
static int s_img_len = 0;

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA && s_img_buf) {
        if ((s_img_len + evt->data_len) <= (LCD_WIDTH * LCD_HEIGHT * 2)) {
            memcpy(s_img_buf + s_img_len, evt->data, evt->data_len);
            s_img_len += evt->data_len;
        }
    }
    return ESP_OK;
}

static bool fetch_and_display(const char *mac_str)
{
    char url[256];
    snprintf(url, sizeof(url), "%s/api/v1/ink/render?mac=%s", SERVER_URL, mac_str);

    s_img_len = 0;
    if (!s_img_buf)
        s_img_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!s_img_buf) return false;

    esp_http_client_config_t config = {
        .url = url,
        .event_handler = http_event_handler,
        .timeout_ms = 30000,
        .buffer_size = 16384,
        .transport_type = HTTP_TRANSPORT_OVER_TCP,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (strlen(s_token) > 0)
        esp_http_client_set_header(client, "x-device-token", s_token);

    /* Telemetry */
    char buf[16];
    snprintf(buf, sizeof(buf), "%d", d1001_battery_percent());
    esp_http_client_set_header(client, "X-Battery-Level", buf);
    snprintf(buf, sizeof(buf), "%d", d1001_battery_voltage());
    esp_http_client_set_header(client, "X-Battery-Voltage", buf);
    esp_http_client_set_header(client, "X-Power-Source", d1001_usb_voltage() > 4000 ? "usb" : "battery");
    esp_http_client_set_header(client, "X-Display-Model", "D1001");

    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);

    /* Sleep headers */
    char *hdr_val = NULL;
    if (esp_http_client_get_header(client, "X-Sleep-Duration", &hdr_val) == ESP_OK && hdr_val)
        s_sleep_duration = (uint32_t)atoi(hdr_val);
    char *mode_val = NULL;
    if (esp_http_client_get_header(client, "X-Sleep-Mode", &mode_val) == ESP_OK && mode_val)
        s_sleep_deep = (strcmp(mode_val, "sleep") == 0);

    esp_http_client_cleanup(client);

    if (err != ESP_OK || status != 200) {
        ESP_LOGW(TAG, "HTTP failed: err=%s status=%d", esp_err_to_name(err), status);
        return false;
    }
    ESP_LOGI(TAG, "Received %d bytes", s_img_len);

    /* Decode JPEG */
    static uint8_t *rgb_buf = NULL;
    if (!rgb_buf)
        rgb_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!rgb_buf) return false;

    esp_jpeg_image_cfg_t jpeg_cfg = {
        .indata = s_img_buf, .indata_size = s_img_len,
        .outbuf = rgb_buf, .outbuf_size = LCD_WIDTH * LCD_HEIGHT * 2,
        .out_format = JPEG_IMAGE_FORMAT_RGB565,
        .out_scale = JPEG_IMAGE_SCALE_0,
    };
    esp_jpeg_image_output_t out;
    if (esp_jpeg_decode(&jpeg_cfg, &out) != ESP_OK) {
        ESP_LOGE(TAG, "JPEG decode failed");
        return false;
    }

    /* Rotate if landscape image on portrait panel */
    uint16_t disp_w = out.width, disp_h = out.height;
    if (out.width > out.height && LCD_HEIGHT > LCD_WIDTH) {
        uint16_t *src = (uint16_t *)rgb_buf;
        uint16_t *dst = heap_caps_malloc(out.width * out.height * 2, MALLOC_CAP_SPIRAM);
        if (dst) {
            for (int y = 0; y < out.height; y++)
                for (int x = 0; x < out.width; x++)
                    dst[x * out.height + (out.height - 1 - y)] = src[y * out.width + x];
            memcpy(rgb_buf, dst, out.width * out.height * 2);
            free(dst);
            disp_w = out.height;
            disp_h = out.width;
        }
    }

    /* Display */
    
    lv_obj_t *scr = lv_display_get_screen_active(s_display);
    lv_obj_clean(scr);
    lv_obj_t *img = lv_image_create(scr);
    static lv_image_dsc_t img_dsc;
    memset(&img_dsc, 0, sizeof(img_dsc));
    img_dsc.header.w = disp_w;
    img_dsc.header.h = disp_h;
    img_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    img_dsc.data_size = disp_w * disp_h * 2;
    img_dsc.data = rgb_buf;
    lv_image_set_src(img, &img_dsc);
    lv_obj_align(img, LV_ALIGN_TOP_LEFT, 0, 0);
    
    return true;
}

/* ─── Button ───────────────────────────────────────────────────────────── */

static void button_task(void *arg)
{
    (void)arg;
    gpio_set_direction(D1001_BUTTON, GPIO_MODE_INPUT);
    while (gpio_get_level(D1001_BUTTON) == 1) vTaskDelay(pdMS_TO_TICKS(50));
    vTaskDelay(pdMS_TO_TICKS(500));

    while (1) {
        if (gpio_get_level(D1001_BUTTON) == 1) {
            int64_t start = esp_timer_get_time();
            int last_cd = -1;
            while (gpio_get_level(D1001_BUTTON) == 1) {
                int64_t held = (esp_timer_get_time() - start) / 1000;
                if (held >= 5000) {
                    int rem = (int)((10000 - held) / 1000);
                    if (rem < 0) rem = 0;
                    if (rem != last_cd) {
                        char msg[64];
                        snprintf(msg, sizeof(msg), "Release now for reboot!\n\nFactory Reset in %d", rem);
                        display_show_status(msg);
                        last_cd = rem;
                    }
                }
                if (held >= 10000) {
                    display_show_status("Factory Reset...");
                    vTaskDelay(pdMS_TO_TICKS(500));
                    nvs_flash_erase();
                    esp_restart();
                }
                vTaskDelay(pdMS_TO_TICKS(50));
            }
            int64_t held = (esp_timer_get_time() - start) / 1000;
            if (held >= 100) esp_restart();
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

/* ─── Main ─────────────────────────────────────────────────────────────── */

void app_main(void)
{
    ESP_LOGI(TAG, "===== Vellum D1001 v6.0 =====");

    ESP_ERROR_CHECK(d1001_board_init());

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    display_init();
    display_show_status("Connecting...");
    wifi_init();

    for (int i = 0; i < 100 && !s_wifi_connected; i++) vTaskDelay(pdMS_TO_TICKS(100));
    if (!s_wifi_connected) { display_show_status("WiFi failed!"); return; }

    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    char mac_str[13];
    snprintf(mac_str, sizeof(mac_str), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    ESP_LOGI(TAG, "MAC: %s", mac_str);

    xTaskCreate(button_task, "button", 4096, NULL, 5, NULL);
    display_show_status("Fetching content...");

    while (1) {
        if (s_wifi_connected) {
            if (fetch_and_display(mac_str)) ESP_LOGI(TAG, "Display updated");
        }
        ESP_LOGI(TAG, "Next: %s for %lus", s_sleep_deep ? "DEEP SLEEP" : "poll", (unsigned long)s_sleep_duration);
        if (s_sleep_deep) {
            d1001_backlight_off();
            esp_sleep_enable_ext1_wakeup(1ULL << D1001_BUTTON, ESP_EXT1_WAKEUP_ANY_HIGH);
            esp_deep_sleep(s_sleep_duration * 1000000ULL);
        }
        vTaskDelay(pdMS_TO_TICKS(s_sleep_duration * 1000));
    }
}
