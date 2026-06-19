// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file panel_epaper.c
 * @brief E-Paper backend (ESP32-S3): UC8179 (GDEY075T7/GDEP073E01) + IT8951
 *        (ED103TC2). Implements vellum_panel() for the shared screen layer.
 */

#include "vellum_panel.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "epaper.h"
#include "epaper_lvgl.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "driver/gpio.h"
#include "sdkconfig.h"

#if defined(CONFIG_VELLUM_PANEL_E1003)
#include "epaper_it8951.h"
#endif

static const char *TAG = "panel_epaper";

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

/* ── Panel config from Kconfig ────────────────────────────────── */

#if defined(CONFIG_VELLUM_PANEL_GDEP073E01)
  #define PANEL_TYPE   EPD_PANEL_GDEP073E01
  #define PANEL_MODEL  "e1002"
  #define PANEL_WIDTH  800
  #define PANEL_HEIGHT 480
  #define PANEL_BPP    4
  #define PANEL_COLORS "color"
  #define PANEL_FAST_REFRESH false
#elif defined(CONFIG_VELLUM_PANEL_GDEY075T7)
  #define PANEL_TYPE   EPD_PANEL_GDEY075T7
  #define PANEL_MODEL  "e1001"
  #define PANEL_WIDTH  800
  #define PANEL_HEIGHT 480
  #define PANEL_BPP    1
  #define PANEL_COLORS "mono"
  #define PANEL_FAST_REFRESH true
#elif defined(CONFIG_VELLUM_PANEL_E1003)
  #define PANEL_TYPE   EPD_PANEL_ED103TC2
  #define PANEL_MODEL  "e1003"
  #define PANEL_WIDTH  1872
  #define PANEL_HEIGHT 1404
  #define PANEL_BPP    4
  #define PANEL_COLORS "grayscale"
  #define PANEL_FAST_REFRESH true
#else
  #error "No E-Paper display panel selected in Kconfig"
#endif

/* ── Scaled fonts (based on shorter panel dimension) ──────────── */
#define PANEL_SHORT_SIDE ((PANEL_WIDTH < PANEL_HEIGHT) ? PANEL_WIDTH : PANEL_HEIGHT)
#if PANEL_SHORT_SIDE > 1000
  /* High-res (E1003: 1404px short side) */
  #define FONT_LG   (&lv_font_montserrat_48)
  #define FONT_MD   (&lv_font_montserrat_48)
  #define FONT_SM   (&lv_font_montserrat_48)
  #define FONT_XS   (&lv_font_montserrat_24)
#else
  /* Standard (E1001/E1002: 480px short side) */
  #define FONT_LG   (&lv_font_montserrat_48)
  #define FONT_MD   (&lv_font_montserrat_24)
  #define FONT_SM   (&lv_font_montserrat_18)
  #define FONT_XS   (&lv_font_montserrat_14)
#endif

/* ── Logo (selected at compile time) ──────────────────────────── */
#if defined(CONFIG_VELLUM_PANEL_E1003)
extern const lv_img_dsc_t vellum_logo_16grey_600px;
#define LOGO_DSC (&vellum_logo_16grey_600px)
#else
extern const lv_img_dsc_t vellum_logo_mono_300px;
#define LOGO_DSC (&vellum_logo_mono_300px)
#endif

static epd_handle_t s_epd = NULL;
static lv_display_t *s_disp = NULL;

/* ── IT8951 LVGL flush ────────────────────────────────────────── */
#if defined(CONFIG_VELLUM_PANEL_E1003)
static void it8951_lvgl_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    /* Convert L8 (8bpp grayscale) to 4bpp for IT8951 */
    int32_t w = area->x2 - area->x1 + 1;
    int32_t h = area->y2 - area->y1 + 1;
    size_t buf_size = (size_t)w * h / 2;
    uint8_t *buf = heap_caps_malloc(buf_size, MALLOC_CAP_SPIRAM);
    if (buf) {
        for (int32_t y = 0; y < h; y++) {
            for (int32_t x = 0; x < w; x += 2) {
                uint8_t p1 = px_map[y * w + x] >> 4;       /* 8bpp → 4bpp */
                uint8_t p2 = (x + 1 < w) ? (px_map[y * w + x + 1] >> 4) : 0xF;
                buf[(y * w + x) / 2] = (p1 << 4) | p2;
            }
        }
        it8951_load_image_4bpp(buf, area->x1, area->y1, w, h);
        heap_caps_free(buf);
    }
    if (lv_display_flush_is_last(disp)) {
        it8951_display_area(0, 0, PANEL_WIDTH, PANEL_HEIGHT, 2);
    }
    lv_display_flush_ready(disp);
}
#endif

/* ── vtable ops ───────────────────────────────────────────────── */

static lv_display_t *ep_init(void)
{
    /* Deselect SD card to avoid SPI bus conflict */
    gpio_set_direction(SD_PIN_CS, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_CS, 1);
    gpio_set_direction(SD_PIN_EN, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_EN, 0);

#if defined(CONFIG_VELLUM_PANEL_E1003)
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
    if (it8951_init(&tcon_cfg) != ESP_OK) {
        ESP_LOGE(TAG, "it8951_init failed");
        return NULL;
    }
    s_epd = NULL;  /* IT8951 doesn't use the epd_handle */

    lv_init();
    /* E1003: 8bpp grayscale (L8), partial render in PSRAM */
    size_t lvgl_buf_size = (size_t)PANEL_WIDTH * 100; /* 100 rows at 8bpp */
    uint8_t *lvgl_buf = heap_caps_calloc(1, lvgl_buf_size, MALLOC_CAP_SPIRAM);
    if (!lvgl_buf) return NULL;
    s_disp = lv_display_create(PANEL_WIDTH, PANEL_HEIGHT);
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_L8);
    lv_display_set_buffers(s_disp, lvgl_buf, NULL, lvgl_buf_size, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(s_disp, it8951_lvgl_flush);
    ESP_LOGI(TAG, "LVGL display initialized for IT8951 L8 (%zu bytes)", lvgl_buf_size);
#else
    epd_config_t cfg = {
        .pins = { .busy = EPD_PIN_BUSY, .rst = EPD_PIN_RST, .dc = EPD_PIN_DC,
                  .cs = EPD_PIN_CS, .sck = EPD_PIN_SCK, .mosi = EPD_PIN_MOSI },
        .spi  = { .host = SPI2_HOST, .speed_hz = 2000000 },
        .panel = { .type = PANEL_TYPE },
    };
    if (epd_init(&cfg, &s_epd) != ESP_OK) {
        ESP_LOGE(TAG, "epd_init failed");
        return NULL;
    }
    lv_init();
    epd_lvgl_config_t lvgl_cfg = EPD_LVGL_CONFIG_DEFAULT();
    lvgl_cfg.epd = s_epd;
    lvgl_cfg.update_mode = EPD_UPDATE_FULL;
    s_disp = epd_lvgl_init(&lvgl_cfg);
#endif
    return s_disp;
}

static void ep_refresh(void)
{
    if (!s_disp) return;
#if defined(CONFIG_VELLUM_PANEL_E1003)
    lv_obj_invalidate(lv_screen_active());
    lv_tick_inc(100);
    lv_timer_handler();
#else
    epd_lvgl_refresh(s_disp);
#endif
}

static esp_err_t ep_draw_raw(const uint8_t *buffer, size_t len)
{
    size_t expected = (size_t)PANEL_WIDTH * PANEL_HEIGHT * PANEL_BPP / 8;
    if (len != expected) {
        ESP_LOGW(TAG, "Buffer size mismatch: %zu (expected %zu)", len, expected);
        return ESP_ERR_INVALID_SIZE;
    }
#if defined(CONFIG_VELLUM_PANEL_E1003)
    esp_err_t ret = it8951_load_image_4bpp(buffer, 0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    if (ret != ESP_OK) return ret;
    return it8951_display_area(0, 0, PANEL_WIDTH, PANEL_HEIGHT, 2); /* GC16 mode */
#else
    if (!s_epd) return ESP_ERR_INVALID_STATE;
    return epd_update(s_epd, buffer, EPD_UPDATE_FULL);
#endif
}

static void ep_sleep(void) { if (s_epd) epd_sleep(s_epd); }
static void ep_wake(void)  { if (s_epd) epd_wake(s_epd); }
static void ep_off(void)   { if (s_epd) epd_sleep(s_epd); }

/* ── Panel descriptor ─────────────────────────────────────────── */

static vellum_panel_t s_panel = {
    .init = ep_init,
    .refresh = ep_refresh,
    .draw_raw = ep_draw_raw,
    .sleep = ep_sleep,
    .wake = ep_wake,
    .off = ep_off,
    .width = PANEL_WIDTH,
    .height = PANEL_HEIGHT,
    .bpp = PANEL_BPP,
    .model = PANEL_MODEL,
    .color_mode = PANEL_COLORS,
    .fast_refresh = PANEL_FAST_REFRESH,
    .needs_tick_timer = true,
    .font_lg = FONT_LG,
    .font_md = FONT_MD,
    .font_sm = FONT_SM,
    .font_xs = FONT_XS,
    .logo = LOGO_DSC,
};

const vellum_panel_t *vellum_panel(void)
{
    /* lv_color_t isn't a constant expression — set the (light) theme here. */
    s_panel.bg    = lv_color_white();
    s_panel.fg    = lv_color_black();
    s_panel.muted = lv_color_hex(0x808080);
    s_panel.dim   = lv_color_hex(0xAAAAAA);
    return &s_panel;
}
