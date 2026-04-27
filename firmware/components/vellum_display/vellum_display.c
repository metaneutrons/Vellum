// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_display.c
 * @brief Display abstraction using esp_epaper + LVGL 9.
 *
 * Two modes:
 * - Local (LVGL): boot, WiFi setup, OTA, errors
 * - Server (raw buffer): pre-rendered content written directly
 */

#include "vellum_display.h"
#include "epaper.h"
#include "epaper_lvgl.h"
#include "lvgl.h"
#include "qrcode.h"
#include "vellum_logo_img.h"
#include "nvs_manager.h"

#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "sdkconfig.h"

static const char *TAG = "display";

/* SD card pins — must be deselected to avoid SPI bus conflict */
#define SD_PIN_CS   GPIO_NUM_14
#define SD_PIN_EN   GPIO_NUM_16

/* SPI pins shared by all reTerminal E models */
#define EPD_PIN_SCK   GPIO_NUM_7
#define EPD_PIN_MOSI  GPIO_NUM_9
#define EPD_PIN_CS    GPIO_NUM_10
#define EPD_PIN_DC    GPIO_NUM_11
#define EPD_PIN_RST   GPIO_NUM_12
#define EPD_PIN_BUSY  GPIO_NUM_13

static epd_handle_t s_epd = NULL;
static lv_display_t *s_lvgl_disp = NULL;
static char s_last_screen[64] = {0};

static void lvgl_tick_cb(void *arg) { (void)arg; lv_tick_inc(5); }

/** Check if screen already showing this content — skip refresh if so */
static bool screen_unchanged(const char *screen_id)
{
    char stored[64] = {0};
    nvs_manager_get_str("last_scr", stored, sizeof(stored));
    if (strcmp(stored, screen_id) == 0 && strcmp(s_last_screen, screen_id) == 0) {
        ESP_LOGI(TAG, "Screen unchanged (%s) — skipping refresh", screen_id);
        return true;
    }
    strncpy(s_last_screen, screen_id, sizeof(s_last_screen) - 1);
    nvs_manager_set_str("last_scr", screen_id);
    return false;
}

/* ── Panel config from Kconfig ────────────────────────────────── */

#if defined(CONFIG_VELLUM_PANEL_GDEP073E01)
  #define PANEL_TYPE   EPD_PANEL_GDEP073E01
  #define PANEL_MODEL  "e1002"
  #define PANEL_WIDTH  800
  #define PANEL_HEIGHT 480
  #define PANEL_BPP    4
  #define PANEL_COLORS "color"
  #define PANEL_FAST_REFRESH 0
#elif defined(CONFIG_VELLUM_PANEL_GDEY075T7)
  #define PANEL_TYPE   EPD_PANEL_GDEY075T7
  #define PANEL_MODEL  "e1001"
  #define PANEL_WIDTH  800
  #define PANEL_HEIGHT 480
  #define PANEL_BPP    1
  #define PANEL_COLORS "bw"
  #define PANEL_FAST_REFRESH 1
#elif defined(CONFIG_VELLUM_PANEL_E1003)
  /* E1003: 10.3" 16-gray — driver TBD, display init will fail gracefully */
  #define PANEL_TYPE   0  /* placeholder — no esp_epaper driver yet */
  #define PANEL_MODEL  "e1003"
  #define PANEL_WIDTH  1404
  #define PANEL_HEIGHT 1872
  #define PANEL_BPP    4
  #define PANEL_COLORS "grayscale"
  #define PANEL_FAST_REFRESH 1
#else
  #error "No display panel selected in Kconfig"
#endif

/* ── Init ─────────────────────────────────────────────────────── */

esp_err_t display_init(void)
{
    /* Deselect SD card to avoid SPI bus conflict */
    gpio_set_direction(SD_PIN_CS, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_CS, 1);
    gpio_set_direction(SD_PIN_EN, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_EN, 0);

    epd_config_t cfg = {
        .pins = {
            .busy = EPD_PIN_BUSY,
            .rst  = EPD_PIN_RST,
            .dc   = EPD_PIN_DC,
            .cs   = EPD_PIN_CS,
            .sck  = EPD_PIN_SCK,
            .mosi = EPD_PIN_MOSI,
        },
        .spi = {
            .host = SPI2_HOST,
            .speed_hz = 2000000,
        },
        .panel = {
            .type = PANEL_TYPE,
        },
    };

    esp_err_t ret = epd_init(&cfg, &s_epd);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "epd_init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ESP_LOGI(TAG, "Panel: %s (%dx%d, %d bpp, %s)", PANEL_MODEL,
             PANEL_WIDTH, PANEL_HEIGHT, PANEL_BPP, PANEL_COLORS);

    /* Initialize LVGL for local screens */
    lv_init();
    epd_lvgl_config_t lvgl_cfg = EPD_LVGL_CONFIG_DEFAULT();
    lvgl_cfg.epd = s_epd;
    lvgl_cfg.update_mode = EPD_UPDATE_FULL;
    s_lvgl_disp = epd_lvgl_init(&lvgl_cfg);

    if (!s_lvgl_disp) {
        ESP_LOGW(TAG, "LVGL display init failed — local screens unavailable");
    } else {
        /* LVGL needs a tick source — use esp_timer (ISR-safe, no PM conflict) */
        const esp_timer_create_args_t tick_args = {
            .callback = lvgl_tick_cb,
            .name = "lvgl_tick",
        };
        esp_timer_handle_t tick_timer;
        esp_timer_create(&tick_args, &tick_timer);
        esp_timer_start_periodic(tick_timer, 5000); /* 5 ms */
    }

    return ESP_OK;
}

esp_err_t display_get_info(display_info_t *info)
{
    if (!info) return ESP_ERR_INVALID_ARG;
    info->model = PANEL_MODEL;
    info->width = PANEL_WIDTH;
    info->height = PANEL_HEIGHT;
    info->bpp = PANEL_BPP;
    info->color_mode = PANEL_COLORS;
    return ESP_OK;
}

/* ── Local mode: LVGL screens ─────────────────────────────────── */

static void lvgl_refresh(void)
{
    if (!s_lvgl_disp) return;
    epd_lvgl_refresh(s_lvgl_disp);
}

void display_show_boot(const char *version)
{
    /* No separate boot screen — wifi_setup screen includes branding */
    (void)version;
}

static void qr_display_cb(esp_qrcode_handle_t qrcode, void *user_data)
{
    lv_obj_t *canvas = (lv_obj_t *)user_data;
    int qr_size = esp_qrcode_get_size(qrcode);
    int scale = 200 / qr_size;
    if (scale < 1) scale = 1;

    lv_canvas_fill_bg(canvas, lv_color_white(), LV_OPA_COVER);

    for (int y = 0; y < qr_size; y++) {
        for (int x = 0; x < qr_size; x++) {
            if (esp_qrcode_get_module(qrcode, x, y)) {
                for (int sy = 0; sy < scale; sy++) {
                    for (int sx = 0; sx < scale; sx++) {
                        lv_canvas_set_px(canvas, x * scale + sx, y * scale + sy,
                                         lv_color_black(), LV_OPA_COVER);
                    }
                }
            }
        }
    }
}

void display_show_wifi_setup(const char *ssid, const char *url)
{
    if (!s_lvgl_disp) return;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_white(), 0);

    /* Left side: Vellum logo — draw 1-bit bitmap on canvas */
    lv_color_t *logo_buf = heap_caps_malloc(VELLUM_LOGO_W * VELLUM_LOGO_H * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
    if (logo_buf) {
        lv_obj_t *logo_canvas = lv_canvas_create(scr);
        lv_canvas_set_buffer(logo_canvas, logo_buf, VELLUM_LOGO_W, VELLUM_LOGO_H, LV_COLOR_FORMAT_NATIVE);
        lv_canvas_fill_bg(logo_canvas, lv_color_white(), LV_OPA_COVER);
        for (int y = 0; y < VELLUM_LOGO_H; y++) {
            for (int x = 0; x < VELLUM_LOGO_W; x++) {
                int byte_idx = y * VELLUM_LOGO_STRIDE + x / 8;
                int bit_idx = 7 - (x % 8);
                if (vellum_logo_bits[byte_idx] & (1 << bit_idx)) {
                    lv_canvas_set_px(logo_canvas, x, y, lv_color_black(), LV_OPA_COVER);
                }
            }
        }
        lv_obj_set_pos(logo_canvas, 50, 40);
    }

    /* Right side: QR code */
    static lv_color_t qr_buf[200 * 200];
    lv_obj_t *canvas = lv_canvas_create(scr);
    lv_canvas_set_buffer(canvas, qr_buf, 200, 200, LV_COLOR_FORMAT_NATIVE);
    lv_obj_set_pos(canvas, 500, 60);

    esp_qrcode_config_t qr_cfg = {
        .display_func_with_cb = qr_display_cb,
        .max_qrcode_version = 10,
        .qrcode_ecc_level = ESP_QRCODE_ECC_MED,
        .user_data = canvas,
    };
    esp_qrcode_generate(&qr_cfg, url);

    /* WiFi name single line, centered below QR */
    lv_obj_t *lbl_ssid = lv_label_create(scr);
    lv_label_set_text_fmt(lbl_ssid, "WiFi: %s", ssid);
    lv_obj_set_style_text_font(lbl_ssid, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_align(lbl_ssid, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl_ssid, 300);
    lv_obj_align_to(lbl_ssid, canvas, LV_ALIGN_OUT_BOTTOM_MID, 0, 15);

    /* Bottom: instructions — centered, large */
    lv_obj_t *lbl_hint = lv_label_create(scr);
    lv_label_set_text(lbl_hint,
        "Scan QR code, connect to WiFi manually\n"
        "or use Vellum Console to configure this device.");
    lv_obj_set_style_text_font(lbl_hint, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(lbl_hint, lv_color_hex(0x666666), 0);
    lv_obj_set_style_text_align(lbl_hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl_hint, 760);
    lv_obj_align(lbl_hint, LV_ALIGN_BOTTOM_MID, 0, -30);

    /* Bottom-right: firmware version */
    lv_obj_t *lbl_ver = lv_label_create(scr);
    lv_label_set_text(lbl_ver, "v" CONFIG_VELLUM_FIRMWARE_VERSION " • " PANEL_MODEL);
    lv_obj_set_style_text_font(lbl_ver, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl_ver, lv_color_hex(0xAAAAAA), 0);
    lv_obj_align(lbl_ver, LV_ALIGN_BOTTOM_RIGHT, -20, -15);

    lvgl_refresh();
    ESP_LOGI(TAG, "WiFi setup screen shown");
}

void display_show_connecting(const char *ssid)
{
    /* No-op — avoid unnecessary display refresh for transient states */
    (void)ssid;
}

void display_show_ota_progress(uint8_t percent)
{
    if (!s_lvgl_disp) return;

#if PANEL_FAST_REFRESH
    /* Fast display: show progress bar with percentage */
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_white(), 0);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "Updating firmware...");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -50);

    lv_obj_t *bar = lv_bar_create(scr);
    lv_obj_set_size(bar, 400, 30);
    lv_bar_set_value(bar, percent, LV_ANIM_OFF);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, 0);

    lv_obj_t *pct = lv_label_create(scr);
    lv_label_set_text_fmt(pct, "%d%%", percent);
    lv_obj_set_style_text_font(pct, &lv_font_montserrat_18, 0);
    lv_obj_align(pct, LV_ALIGN_CENTER, 0, 35);

    lv_obj_t *warn = lv_label_create(scr);
    lv_label_set_text(warn, "Do not power off");
    lv_obj_set_style_text_color(warn, lv_color_hex(0x888888), 0);
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, 70);

    lvgl_refresh();
#else
    /* Slow display: single static screen, no progress updates */
    (void)percent;
    if (screen_unchanged("ota")) return;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_white(), 0);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "Updating firmware...");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_48, 0);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -20);

    lv_obj_t *warn = lv_label_create(scr);
    lv_label_set_text(warn, "Do not power off");
    lv_obj_set_style_text_font(warn, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(warn, lv_color_hex(0x888888), 0);
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, 30);

    lvgl_refresh();
#endif
}

void display_show_error(const char *message)
{
    if (!s_lvgl_disp) return;
    char screen_id[64];
    snprintf(screen_id, sizeof(screen_id), "error:%s", message);
    if (screen_unchanged(screen_id)) return;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_white(), 0);

    lv_obj_t *icon = lv_label_create(scr);
    lv_label_set_text(icon, LV_SYMBOL_WARNING);
    lv_obj_set_style_text_font(icon, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(icon, lv_color_hex(0xCC0000), 0);
    lv_obj_align(icon, LV_ALIGN_CENTER, 0, -60);

    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, message);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, 700);
    lv_obj_align(lbl, LV_ALIGN_CENTER, 0, 40);

    lvgl_refresh();
}

void display_show_low_battery(void)
{
    display_show_error("Low Battery\nPlease charge");
}

/* ── Server mode: raw pixel buffer ────────────────────────────── */

esp_err_t display_update_raw(const uint8_t *buffer, size_t len)
{
    if (!s_epd || !buffer) return ESP_ERR_INVALID_ARG;

    size_t expected = (size_t)PANEL_WIDTH * PANEL_HEIGHT * PANEL_BPP / 8;
    if (len != expected) {
        ESP_LOGW(TAG, "Buffer size mismatch: %zu (expected %zu)", len, expected);
        return ESP_ERR_INVALID_SIZE;
    }

    /* Clear last screen marker — server content is always fresh */
    s_last_screen[0] = '\0';
    nvs_manager_set_str("last_scr", "");

    return epd_update(s_epd, buffer, EPD_UPDATE_FULL);
}

/* ── Power management ─────────────────────────────────────────── */

esp_err_t display_sleep(void)
{
    if (!s_epd) return ESP_ERR_INVALID_STATE;
    return epd_sleep(s_epd);
}

esp_err_t display_wake(void)
{
    if (!s_epd) return ESP_ERR_INVALID_STATE;
    return epd_wake(s_epd);
}
