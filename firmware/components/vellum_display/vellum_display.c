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
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "epaper.h"
#include "epaper_lvgl.h"
#include "lvgl.h"
#include "qrcode.h"
#include "vellum_logo_img.h"
#include "nvs_manager.h"

#if defined(CONFIG_VELLUM_PANEL_E1003)
#include "epaper_it8951.h"
#endif

#if defined(CONFIG_VELLUM_PANEL_D1001)
#include "d1001_board.h"
#include "lcd_jd9365.h"
#include "esp_lcd_mipi_dsi.h"
#include "jpeg_decoder.h"
#endif

#include <string.h>

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
  #define PANEL_COLORS "mono"
  #define PANEL_FAST_REFRESH 1
#elif defined(CONFIG_VELLUM_PANEL_E1003)
  #define PANEL_TYPE   EPD_PANEL_ED103TC2
  #define PANEL_MODEL  "e1003"
  #define PANEL_WIDTH  1872
  #define PANEL_HEIGHT 1404
  #define PANEL_BPP    4
  #define PANEL_COLORS "grayscale"
  #define PANEL_FAST_REFRESH 1
#elif defined(CONFIG_VELLUM_PANEL_D1001)
  #define PANEL_MODEL  "d1001"
  #define PANEL_WIDTH  800
  #define PANEL_HEIGHT 1280
  #define PANEL_BPP    16
  #define PANEL_COLORS "fullcolor"
  #define PANEL_FAST_REFRESH 0
  #define PANEL_IS_LCD 1
#else
  #error "No display panel selected in Kconfig"
#endif

/* ── Theme colors (dark mode for LCD, light for E-Paper) ──────── */
#ifdef PANEL_IS_LCD
  #define THEME_BG        lv_color_black()
  #define THEME_FG        lv_color_white()
  #define THEME_MUTED     lv_color_hex(0x999999)
  #define THEME_DIM       lv_color_hex(0x666666)
  #define THEME_BG_OPA    LV_OPA_COVER
#else
  #define THEME_BG        lv_color_white()
  #define THEME_FG        lv_color_black()
  #define THEME_MUTED     lv_color_hex(0x808080)
  #define THEME_DIM       lv_color_hex(0xAAAAAA)
  #define THEME_BG_OPA    LV_OPA_COVER
#endif

/* ── IT8951 LVGL flush ────────────────────────────────────────── */
#if defined(CONFIG_VELLUM_PANEL_E1003)
static void it8951_lvgl_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    /* Convert 1bpp (I1) to 4bpp for IT8951 */
    size_t buf_size = (size_t)PANEL_WIDTH * PANEL_HEIGHT / 2;
    uint8_t *buf = heap_caps_malloc(buf_size, MALLOC_CAP_SPIRAM);
    if (buf) {
        uint32_t total_pixels = (uint32_t)PANEL_WIDTH * PANEL_HEIGHT;
        for (uint32_t i = 0; i < total_pixels; i += 2) {
            uint8_t byte = px_map[i / 8];
            uint8_t bit1 = (byte >> (7 - (i % 8))) & 1;
            uint8_t bit2 = (byte >> (7 - ((i + 1) % 8))) & 1;
            /* 1=white(0xF), 0=black(0x0) */
            buf[i / 2] = (bit1 ? 0xF0 : 0x00) | (bit2 ? 0x0F : 0x00);
        }
        it8951_load_image_4bpp(buf, 0, 0, PANEL_WIDTH, PANEL_HEIGHT);
        it8951_display_area(0, 0, PANEL_WIDTH, PANEL_HEIGHT, 2);
        heap_caps_free(buf);
    }
    lv_display_flush_ready(disp);
}
#endif

/* ── Init ─────────────────────────────────────────────────────── */

#if defined(CONFIG_VELLUM_PANEL_D1001)
static void lcd_flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    lv_display_flush_ready(disp);
}

static void lvgl_handler_task(void *arg)
{
    (void)arg;
    while (1) {
        lv_tick_inc(10);
        lv_timer_handler();
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
#endif

esp_err_t display_init(void)
{
    /* Deselect SD card to avoid SPI bus conflict */
    gpio_set_direction(SD_PIN_CS, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_CS, 1);
    gpio_set_direction(SD_PIN_EN, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_EN, 0);

#if defined(CONFIG_VELLUM_PANEL_E1003)
    /* IT8951 TCON — different protocol than UC8179 */
    it8951_config_t tcon_cfg = {
        .pin_busy = EPD_PIN_BUSY,
        .pin_rst  = EPD_PIN_RST,
        .pin_cs   = EPD_PIN_CS,
        .pin_sck  = EPD_PIN_SCK,
        .pin_mosi = EPD_PIN_MOSI,
        .pin_miso = 8,  /* SD_MISO shared */
        .spi_host = SPI2_HOST,
        .speed_hz = 12000000, /* IT8951 supports up to 24MHz */
    };
    esp_err_t ret = it8951_init(&tcon_cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "it8951_init failed: %s", esp_err_to_name(ret));
        return ret;
    }
    /* For E1003, we don't use the epd_handle — set to NULL */
    s_epd = NULL;
#elif defined(CONFIG_VELLUM_PANEL_D1001)
    /* D1001 LCD — MIPI-DSI + JD9365 (board already initialized in main) */
    lcd_jd9365_config_t lcd_cfg = {
        .lane_num = D1001_DSI_LANE_NUM,
        .lane_mbps = D1001_DSI_LANE_MBPS,
        .phy_ldo_chan = D1001_DSI_PHY_LDO_CHAN,
        .phy_ldo_mv = D1001_DSI_PHY_LDO_MV,
        .h_res = PANEL_WIDTH, .v_res = PANEL_HEIGHT,
        .num_fb = 2,
        .io_expander = d1001_io_expander(),
        .rst_mask = D1001_EXP_LCD_RST,
    };
    static esp_lcd_panel_handle_t s_lcd_panel = NULL;
    static esp_lcd_panel_io_handle_t s_lcd_io = NULL;
    esp_err_t ret = lcd_jd9365_init(&lcd_cfg, &s_lcd_panel, &s_lcd_io);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "lcd_jd9365_init failed: %s", esp_err_to_name(ret));
        return ret;
    }
    s_epd = NULL;
#else
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
#endif

    ESP_LOGI(TAG, "Panel: %s (%dx%d, %d bpp, %s)", PANEL_MODEL,
             PANEL_WIDTH, PANEL_HEIGHT, PANEL_BPP, PANEL_COLORS);

    /* Initialize LVGL for local screens */
    lv_init();
#if defined(CONFIG_VELLUM_PANEL_E1003)
    /* E1003: Full framebuffer in PSRAM, 1-bit (same as other ePaper panels) */
    size_t lvgl_buf_size = (size_t)PANEL_WIDTH * PANEL_HEIGHT / 8; /* 1bpp */
    uint8_t *lvgl_buf = heap_caps_calloc(1, lvgl_buf_size, MALLOC_CAP_SPIRAM);
    if (lvgl_buf) {
        s_lvgl_disp = lv_display_create(PANEL_WIDTH, PANEL_HEIGHT);
        lv_display_set_color_format(s_lvgl_disp, LV_COLOR_FORMAT_I1);
        lv_display_set_buffers(s_lvgl_disp, lvgl_buf, NULL, lvgl_buf_size, LV_DISPLAY_RENDER_MODE_FULL);
        lv_display_set_flush_cb(s_lvgl_disp, it8951_lvgl_flush);
        ESP_LOGI(TAG, "LVGL display initialized for IT8951 (%zu bytes)", lvgl_buf_size);
    }
#elif defined(CONFIG_VELLUM_PANEL_D1001)
    /* D1001: Direct DPI framebuffers */
    {
        void *buf1 = NULL, *buf2 = NULL;
        esp_lcd_dpi_panel_get_frame_buffer(s_lcd_panel, 2, &buf1, &buf2);
        s_lvgl_disp = lv_display_create(PANEL_WIDTH, PANEL_HEIGHT);
        lv_display_set_buffers(s_lvgl_disp, buf1, buf2, PANEL_WIDTH * PANEL_HEIGHT * 2, LV_DISPLAY_RENDER_MODE_DIRECT);
        lv_display_set_flush_cb(s_lvgl_disp, lcd_flush_cb);
        d1001_backlight_on();
        ESP_LOGI(TAG, "LVGL display initialized for D1001 LCD");
    }
    /* Start background LVGL handler task for continuous LCD rendering */
    xTaskCreate(lvgl_handler_task, "lvgl", 4096, NULL, 5, NULL);
#else
    epd_lvgl_config_t lvgl_cfg = EPD_LVGL_CONFIG_DEFAULT();
    lvgl_cfg.epd = s_epd;
    lvgl_cfg.update_mode = EPD_UPDATE_FULL;
    s_lvgl_disp = epd_lvgl_init(&lvgl_cfg);
#endif

    if (!s_lvgl_disp) {
        ESP_LOGW(TAG, "LVGL display init failed — local screens unavailable");
    } else {
#if !defined(CONFIG_VELLUM_PANEL_D1001)
        /* E-Paper: LVGL tick via esp_timer (no background handler task) */
        const esp_timer_create_args_t tick_args = {
            .callback = lvgl_tick_cb,
            .name = "lvgl_tick",
        };
        esp_timer_handle_t tick_timer;
        esp_timer_create(&tick_args, &tick_timer);
        esp_timer_start_periodic(tick_timer, 5000); /* 5 ms */
#endif
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
#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* LCD: handler task renders continuously, just invalidate */
    lv_obj_invalidate(lv_screen_active());
#elif defined(CONFIG_VELLUM_PANEL_E1003)
    lv_obj_invalidate(lv_screen_active());
    lv_tick_inc(100);
    lv_timer_handler();
#else
    epd_lvgl_refresh(s_lvgl_disp);
#endif
}

/* Pre-rendered logo buffer (shared across screens) */
static uint8_t *s_logo_rgb = NULL;
static lv_image_dsc_t s_logo_dsc;

static void ensure_logo_rendered(void)
{
    if (s_logo_rgb) return;
    s_logo_rgb = heap_caps_malloc(VELLUM_LOGO_W * VELLUM_LOGO_H * 2, MALLOC_CAP_SPIRAM);
    if (!s_logo_rgb) return;
    uint16_t *px = (uint16_t *)s_logo_rgb;
    for (int y = 0; y < VELLUM_LOGO_H; y++) {
        for (int x = 0; x < VELLUM_LOGO_W; x++) {
            int byte_idx = y * VELLUM_LOGO_STRIDE + (x / 8);
            int bit_idx = 7 - (x % 8);
            px[y * VELLUM_LOGO_W + x] = (vellum_logo_bits[byte_idx] & (1 << bit_idx)) ? 0x0000 : 0xFFFF;
        }
    }
    memset(&s_logo_dsc, 0, sizeof(s_logo_dsc));
    s_logo_dsc.header.w = VELLUM_LOGO_W;
    s_logo_dsc.header.h = VELLUM_LOGO_H;
    s_logo_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    s_logo_dsc.data_size = VELLUM_LOGO_W * VELLUM_LOGO_H * 2;
    s_logo_dsc.data = s_logo_rgb;
}

static lv_obj_t *add_logo(lv_obj_t *parent)
{
#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* LCD: Pre-render logo into buffer once, then just assign to canvas */
    static lv_color_t *logo_canvas_buf = NULL;
    static bool logo_rendered = false;
    if (!logo_canvas_buf)
        logo_canvas_buf = heap_caps_malloc(VELLUM_LOGO_W * VELLUM_LOGO_H * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
    if (!logo_canvas_buf) return NULL;

    if (!logo_rendered) {
        /* Render once — fill with theme colors */
        lv_color_t fg = THEME_FG;
        lv_color_t bg = THEME_BG;
        for (int y = 0; y < VELLUM_LOGO_H; y++) {
            for (int x = 0; x < VELLUM_LOGO_W; x++) {
                int byte_idx = y * VELLUM_LOGO_STRIDE + (x / 8);
                int bit_idx = 7 - (x % 8);
                logo_canvas_buf[y * VELLUM_LOGO_W + x] = (vellum_logo_bits[byte_idx] & (1 << bit_idx)) ? fg : bg;
            }
        }
        logo_rendered = true;
    }

    lv_obj_t *canvas = lv_canvas_create(parent);
    lv_canvas_set_buffer(canvas, logo_canvas_buf, VELLUM_LOGO_W, VELLUM_LOGO_H, LV_COLOR_FORMAT_NATIVE);
    return canvas;
#else
    ensure_logo_rendered();
    if (!s_logo_rgb) return NULL;
    lv_obj_t *img = lv_image_create(parent);
    lv_image_set_src(img, &s_logo_dsc);
    return img;
#endif
}

void display_show_boot(const char *version)
{
    if (!s_lvgl_disp) return;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, THEME_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    /* Flex column, centered */
    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    add_logo(scr);

    lv_obj_t *ver = lv_label_create(scr);
    char ver_str[64];
    snprintf(ver_str, sizeof(ver_str), "v%s | %s", version, PANEL_MODEL);
    lv_label_set_text(ver, ver_str);
    lv_obj_set_style_text_font(ver, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(ver, THEME_MUTED, 0);

    /* LVGL task will render this */
}

static int s_qr_canvas_size = 200;

static void qr_display_cb(esp_qrcode_handle_t qrcode, void *user_data)
{
    lv_obj_t *canvas = (lv_obj_t *)user_data;
    int qr_size = esp_qrcode_get_size(qrcode);
    int scale = s_qr_canvas_size / qr_size;
    if (scale < 1) scale = 1;

    lv_canvas_fill_bg(canvas, THEME_BG, LV_OPA_COVER);

    for (int y = 0; y < qr_size; y++) {
        for (int x = 0; x < qr_size; x++) {
            if (esp_qrcode_get_module(qrcode, x, y)) {
                for (int sy = 0; sy < scale; sy++) {
                    for (int sx = 0; sx < scale; sx++) {
                        lv_canvas_set_px(canvas, x * scale + sx, y * scale + sy,
                                         THEME_FG, LV_OPA_COVER);
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
    lv_obj_set_style_bg_color(scr, THEME_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    /* Flex container — vertical, centered */
    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(scr, 20, 0);
    lv_obj_set_style_pad_top(scr, 40, 0);

    /* QR code */
    int qr_size = (PANEL_WIDTH < PANEL_HEIGHT) ? PANEL_WIDTH / 3 : PANEL_HEIGHT / 3;
    if (qr_size > 250) qr_size = 250;
    if (qr_size < 120) qr_size = 120;
    static lv_color_t *qr_buf = NULL;
    if (!qr_buf) qr_buf = heap_caps_malloc(qr_size * qr_size * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);
    if (qr_buf) {
        lv_obj_t *canvas = lv_canvas_create(scr);
        lv_canvas_set_buffer(canvas, qr_buf, qr_size, qr_size, LV_COLOR_FORMAT_NATIVE);
        esp_qrcode_config_t qr_cfg = {
            .display_func_with_cb = qr_display_cb,
            .max_qrcode_version = 10,
            .qrcode_ecc_level = ESP_QRCODE_ECC_MED,
            .user_data = canvas,
        };
        s_qr_canvas_size = qr_size;
        esp_qrcode_generate(&qr_cfg, url);
    }

    /* WiFi SSID */
    lv_obj_t *lbl_ssid = lv_label_create(scr);
    lv_label_set_text_fmt(lbl_ssid, "WiFi: %s", ssid);
    lv_obj_set_style_text_font(lbl_ssid, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_align(lbl_ssid, LV_TEXT_ALIGN_CENTER, 0);

    /* Instructions */
    lv_obj_t *lbl_hint = lv_label_create(scr);
    lv_label_set_text(lbl_hint,
        "Scan QR code to configure WiFi\n"
        "or use Vellum Console via USB.");
    lv_obj_set_style_text_font(lbl_hint, &lv_font_montserrat_18, 0);
    lv_obj_set_style_text_color(lbl_hint, THEME_MUTED, 0);
    lv_obj_set_style_text_align(lbl_hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl_hint, PANEL_WIDTH * 3 / 4);

    /* Version */
    lv_obj_t *lbl_ver = lv_label_create(scr);
    lv_label_set_text(lbl_ver, "v" CONFIG_VELLUM_FIRMWARE_VERSION " | " PANEL_MODEL);
    lv_obj_set_style_text_font(lbl_ver, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(lbl_ver, THEME_DIM, 0);

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
    lv_obj_set_style_bg_color(scr, THEME_BG, 0);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "Updating firmware...");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_24, 0);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -50);

    lv_obj_t *bar = lv_bar_create(scr);
    lv_obj_set_size(bar, PANEL_WIDTH / 2, 30);
    lv_bar_set_value(bar, percent, LV_ANIM_OFF);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, 0);

    lv_obj_t *pct = lv_label_create(scr);
    lv_label_set_text_fmt(pct, "%d%%", percent);
    lv_obj_set_style_text_font(pct, &lv_font_montserrat_18, 0);
    lv_obj_align(pct, LV_ALIGN_CENTER, 0, 35);

    lv_obj_t *warn = lv_label_create(scr);
    lv_label_set_text(warn, "Do not power off");
    lv_obj_set_style_text_color(warn, THEME_MUTED, 0);
    lv_obj_align(warn, LV_ALIGN_CENTER, 0, 70);

    lvgl_refresh();
#else
    /* Slow display: single static screen, no progress updates */
    (void)percent;
    if (screen_unchanged("ota")) return;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, THEME_BG, 0);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "Updating firmware...");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_48, 0);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, -20);

    lv_obj_t *warn = lv_label_create(scr);
    lv_label_set_text(warn, "Do not power off");
    lv_obj_set_style_text_font(warn, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_color(warn, THEME_MUTED, 0);
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
    lv_obj_set_style_bg_color(scr, THEME_BG, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

    lv_obj_t *icon = lv_label_create(scr);
    lv_label_set_text(icon, LV_SYMBOL_WARNING);
    lv_obj_set_style_text_font(icon, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(icon, lv_color_hex(0xCC0000), 0);

    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, message);
    lv_obj_set_style_text_font(lbl, &lv_font_montserrat_24, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, PANEL_WIDTH * 3 / 4);

    lvgl_refresh();
}

void display_show_low_battery(void)
{
    display_show_error("Low Battery\nPlease charge");
}

/* ── Server mode: raw pixel buffer ────────────────────────────── */

esp_err_t display_update_raw(const uint8_t *buffer, size_t len)
{
    if (!buffer) return ESP_ERR_INVALID_ARG;

    size_t expected = (size_t)PANEL_WIDTH * PANEL_HEIGHT * PANEL_BPP / 8;
    if (len != expected) {
        ESP_LOGW(TAG, "Buffer size mismatch: %zu (expected %zu)", len, expected);
        return ESP_ERR_INVALID_SIZE;
    }

    /* Clear last screen marker — server content is always fresh */
    s_last_screen[0] = '\0';
    nvs_manager_set_str("last_scr", "");

#if defined(CONFIG_VELLUM_PANEL_E1003)
    esp_err_t ret = it8951_load_image_4bpp(buffer, 0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    if (ret != ESP_OK) return ret;
    return it8951_display_area(0, 0, PANEL_WIDTH, PANEL_HEIGHT, 2); /* GC16 mode */
#elif defined(CONFIG_VELLUM_PANEL_D1001)
    /* Decode JPEG to RGB565 and display via LVGL */
    static uint8_t *s_rgb_buf = NULL;
    if (!s_rgb_buf)
        s_rgb_buf = heap_caps_malloc(PANEL_WIDTH * PANEL_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!s_rgb_buf) return ESP_ERR_NO_MEM;

    esp_jpeg_image_cfg_t jpeg_cfg = {
        .indata = (uint8_t *)buffer, .indata_size = len,
        .outbuf = s_rgb_buf, .outbuf_size = PANEL_WIDTH * PANEL_HEIGHT * 2,
        .out_format = JPEG_IMAGE_FORMAT_RGB565,
        .out_scale = JPEG_IMAGE_SCALE_0,
    };
    esp_jpeg_image_output_t out;
    esp_err_t ret = esp_jpeg_decode(&jpeg_cfg, &out);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "JPEG decode failed: %s", esp_err_to_name(ret));
        return ret;
    }

    /* Rotate if landscape image on portrait panel */
    uint16_t disp_w = out.width, disp_h = out.height;
    if (out.width > out.height && PANEL_HEIGHT > PANEL_WIDTH) {
        uint16_t *src = (uint16_t *)s_rgb_buf;
        uint16_t *dst = heap_caps_malloc(out.width * out.height * 2, MALLOC_CAP_SPIRAM);
        if (dst) {
            for (int y = 0; y < out.height; y++)
                for (int x = 0; x < out.width; x++)
                    dst[x * out.height + (out.height - 1 - y)] = src[y * out.width + x];
            memcpy(s_rgb_buf, dst, out.width * out.height * 2);
            free(dst);
            disp_w = out.height; disp_h = out.width;
        }
    }

    /* Display via LVGL image */
    lv_obj_t *scr = lv_display_get_screen_active(s_lvgl_disp);
    lv_obj_clean(scr);
    lv_obj_t *img = lv_image_create(scr);
    static lv_image_dsc_t img_dsc;
    memset(&img_dsc, 0, sizeof(img_dsc));
    img_dsc.header.w = disp_w;
    img_dsc.header.h = disp_h;
    img_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    img_dsc.data_size = disp_w * disp_h * 2;
    img_dsc.data = s_rgb_buf;
    lv_image_set_src(img, &img_dsc);
    lv_obj_align(img, LV_ALIGN_TOP_LEFT, 0, 0);
    /* LVGL task will render this */
    return ESP_OK;
#else
    if (!s_epd) return ESP_ERR_INVALID_STATE;
    return epd_update(s_epd, buffer, EPD_UPDATE_FULL);
#endif
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
