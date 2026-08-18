// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file panel_lcd.c
 * @brief LCD backend (ESP32-P4): JD9365 MIPI-DSI. Implements vellum_panel()
 *        for the shared screen layer (d1001 / 800x1280 RGB565).
 */

#include "vellum_panel.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_cache.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "lvgl.h"
#include "esp_lv_adapter.h"
#include "d1001_board.h"
#include "lcd_jd9365.h"
#include "jpeg_decoder.h"
#include "lcd_rotation.h"

/* Static image descriptor in flash. Building it in PSRAM at boot (malloc + a
 * full-image memcpy) bought nothing for an asset that never changes, and held
 * ~190 KB of PSRAM for the lifetime of the device. */
extern const lv_image_dsc_t vellum_logo_color_360px;

static const char *TAG = "panel_lcd";

#define LCD_WIDTH       800
#define LCD_HEIGHT      1280
#define LCD_DRAW_LINES  24

static lv_display_t *s_disp = NULL;
static uint16_t *s_framebuffers[3] = { NULL, NULL, NULL };
static SemaphoreHandle_t s_vsync_sem = NULL;

/* The adapter normally owns the DPI callbacks. D1001 also needs a VSYNC gate
 * for its tiny native OTA updates, so forward the callbacks into the adapter
 * while exposing the same frame boundary to this backend. */
static bool IRAM_ATTR lcd_color_done_cb(esp_lcd_panel_handle_t panel,
                                        esp_lcd_dpi_panel_event_data_t *event,
                                        void *user_ctx)
{
    (void)panel;
    (void)event;
    (void)user_ctx;
    return esp_lv_adapter_display_notify_color_trans_done_from_isr(s_disp);
}

static bool IRAM_ATTR lcd_frame_done_cb(esp_lcd_panel_handle_t panel,
                                        esp_lcd_dpi_panel_event_data_t *event,
                                        void *user_ctx)
{
    (void)panel;
    (void)event;
    (void)user_ctx;
    BaseType_t wake = pdFALSE;
    if (s_vsync_sem) xSemaphoreGiveFromISR(s_vsync_sem, &wake);
    bool adapter_wake = esp_lv_adapter_display_notify_frame_buf_complete_from_isr(s_disp);
    return adapter_wake || wake == pdTRUE;
}

static esp_err_t lcd_update_ota_progress(uint8_t percent, int x, int y,
                                         int width, int height)
{
    if (!s_vsync_sem || !s_framebuffers[0] || x < 0 || y < 0 ||
        width <= 0 || height <= 0 || x + width > LCD_HEIGHT ||
        y + height > LCD_WIDTH) {
        return ESP_ERR_INVALID_STATE;
    }
    if (percent > 100) percent = 100;

    /* Discard an old frame notification and begin immediately after the next
     * VSYNC. The logical horizontal bar becomes a narrow vertical rectangle in
     * the portrait scanout buffer. Updating that rectangle in all three buffers
     * keeps the adapter's pipeline coherent without a framebuffer switch. */
    (void)xSemaphoreTake(s_vsync_sem, 0);
    if (xSemaphoreTake(s_vsync_sem, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "Timed out waiting for OTA progress VSYNC");
    }

    const int filled = width * percent / 100;
    const uint16_t track = lv_color_to_u16(lv_color_hex(0x363434));
    const uint16_t active = lv_color_to_u16(
        lv_color_hex(percent == 100 ? 0x30D158 : 0xE9177B));
    const int first_row = LCD_HEIGHT - x - width;

    for (size_t fb_index = 0; fb_index < 3; ++fb_index) {
        uint16_t *fb = s_framebuffers[fb_index];
        for (int logical_x = x; logical_x < x + width; ++logical_x) {
            uint16_t *row = fb + lcd_rotation_90_cw_index(
                logical_x, y, LCD_WIDTH, LCD_HEIGHT);
            const uint16_t color = logical_x < x + filled ? active : track;
            for (int column = 0; column < height; ++column) row[column] = color;
        }
        for (int row_index = first_row; row_index < first_row + width; ++row_index) {
            uint16_t *row = fb + (size_t)row_index * LCD_WIDTH + y;
            esp_err_t err = esp_cache_msync(
                row, (size_t)height * sizeof(uint16_t),
                ESP_CACHE_MSYNC_FLAG_DIR_C2M | ESP_CACHE_MSYNC_FLAG_UNALIGNED);
            if (err != ESP_OK) return err;
        }
    }
    return ESP_OK;
}

/* ── vtable ops ───────────────────────────────────────────────── */

static lv_display_t *lcd_init(void)
{
    const esp_lv_adapter_rotation_t rotation = ESP_LV_ADAPTER_ROTATE_270;
    const esp_lv_adapter_tear_avoid_mode_t tear_mode =
        ESP_LV_ADAPTER_TEAR_AVOID_MODE_TRIPLE_PARTIAL;

    lcd_jd9365_config_t lcd_cfg = {
        .lane_num = D1001_DSI_LANE_NUM,
        .lane_mbps = D1001_DSI_LANE_MBPS,
        .phy_ldo_chan = D1001_DSI_PHY_LDO_CHAN,
        .phy_ldo_mv = D1001_DSI_PHY_LDO_MV,
        .h_res = D1001_LCD_H_RES,
        .v_res = D1001_LCD_V_RES,
        .dpi_clock_mhz = D1001_LCD_DPI_CLOCK_MHZ,
        .hsync = D1001_LCD_HSYNC, .hbp = D1001_LCD_HBP, .hfp = D1001_LCD_HFP,
        .vsync = D1001_LCD_VSYNC, .vbp = D1001_LCD_VBP, .vfp = D1001_LCD_VFP,
        /* Espressif's rotated partial-refresh pipeline requires three physical
         * framebuffers: visible, next-to-present, and safe-to-draw. */
        .num_fb = esp_lv_adapter_get_required_frame_buffer_count(tear_mode, rotation),
        .io_expander = d1001_io_expander(),
        .rst_mask = D1001_EXP_LCD_RST,
    };
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_io_handle_t io = NULL;
    if (lcd_jd9365_init(&lcd_cfg, &panel, &io) != ESP_OK) {
        ESP_LOGE(TAG, "lcd_jd9365_init failed");
        return NULL;
    }

    const esp_lv_adapter_config_t adapter_cfg = ESP_LV_ADAPTER_DEFAULT_CONFIG();
    if (esp_lv_adapter_init(&adapter_cfg) != ESP_OK) {
        ESP_LOGE(TAG, "LVGL adapter initialization failed");
        return NULL;
    }
    ESP_ERROR_CHECK(esp_lv_adapter_set_default_display_idf_callback_registration_enabled(false));

    esp_lv_adapter_display_config_t display_cfg =
        ESP_LV_ADAPTER_DISPLAY_MIPI_DEFAULT_CONFIG(
            panel, io, LCD_WIDTH, LCD_HEIGHT, rotation);
    display_cfg.tear_avoid_mode = tear_mode;
    display_cfg.profile.buffer_height = LCD_DRAW_LINES;
    /* IDF 6.0 still needs an out-of-tree PPA workaround for rotated
     * TRIPLE_PARTIAL. OTA changes only small dirty regions, so the adapter's
     * cache-friendly CPU rotation is both safer and sufficiently fast. */
    display_cfg.profile.enable_ppa_accel = false;

    s_disp = esp_lv_adapter_register_display(&display_cfg);
    if (!s_disp) {
        ESP_LOGE(TAG, "Unable to register tearing-safe LCD display");
        return NULL;
    }

    s_vsync_sem = xSemaphoreCreateBinary();
    if (!s_vsync_sem ||
        esp_lcd_dpi_panel_get_frame_buffer(
            panel, 3, (void **)&s_framebuffers[0],
            (void **)&s_framebuffers[1], (void **)&s_framebuffers[2]) != ESP_OK) {
        ESP_LOGE(TAG, "Unable to initialize native OTA framebuffer path");
        return NULL;
    }
    const esp_lcd_dpi_panel_event_callbacks_t callbacks = {
        .on_color_trans_done = lcd_color_done_cb,
        .on_refresh_done = lcd_frame_done_cb,
    };
    if (esp_lcd_dpi_panel_register_event_callbacks(panel, &callbacks, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "Unable to register D1001 frame callbacks");
        return NULL;
    }

    /* Vellum renders synchronously after each state change. We intentionally do
     * not start the adapter's background worker; this preserves that ownership
     * model while using its VSYNC-synchronised triple-buffer flush pipeline. */
    vTaskDelay(pdMS_TO_TICKS(100));
    d1001_backlight_on();
    ESP_LOGI(TAG, "LCD initialized: %dx%d, %d MHz triple-partial rotation",
             LCD_WIDTH, LCD_HEIGHT, D1001_LCD_DPI_CLOCK_MHZ);
    return s_disp;
}

static void lcd_refresh(void)
{
    if (s_disp) {
        esp_err_t err = esp_lv_adapter_refresh_now(s_disp);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "LCD refresh failed: %s", esp_err_to_name(err));
        }
    }
}

static esp_err_t lcd_draw_raw(const uint8_t *data, size_t len)
{
    if (!data || !s_disp) return ESP_ERR_INVALID_STATE;

    static uint8_t *s_rgb_buf = NULL;
    if (!s_rgb_buf)
        s_rgb_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!s_rgb_buf) return ESP_ERR_NO_MEM;

    esp_jpeg_image_cfg_t jpeg_cfg = {
        .indata = (uint8_t *)data, .indata_size = len,
        .outbuf = s_rgb_buf, .outbuf_size = LCD_WIDTH * LCD_HEIGHT * 2,
        .out_format = JPEG_IMAGE_FORMAT_RGB565,
        .out_scale = JPEG_IMAGE_SCALE_0,
    };
    esp_jpeg_image_output_t out;
    esp_err_t ret = esp_jpeg_decode(&jpeg_cfg, &out);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "JPEG decode failed: %s", esp_err_to_name(ret));
        return ret;
    }

    lv_obj_t *scr = lv_display_get_screen_active(s_disp);
    lv_obj_clean(scr);
    lv_obj_t *img = lv_image_create(scr);
    static lv_image_dsc_t img_dsc;
    memset(&img_dsc, 0, sizeof(img_dsc));
    img_dsc.header.w = out.width;
    img_dsc.header.h = out.height;
    img_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    img_dsc.data_size = out.width * out.height * 2;
    img_dsc.data = s_rgb_buf;
    lv_image_set_src(img, &img_dsc);
    lv_obj_align(img, LV_ALIGN_TOP_LEFT, 0, 0);
    lcd_refresh();
    return ESP_OK;
}

static void lcd_off(void) { d1001_backlight_off(); }
static void lcd_wake(void) { d1001_backlight_on(); }

/* ── Panel descriptor ─────────────────────────────────────────── */

extern const lv_font_t vellum_font_montserrat_48;
extern const lv_font_t vellum_font_montserrat_32;
extern const lv_font_t vellum_font_montserrat_24;
extern const lv_font_t vellum_font_montserrat_16;

static vellum_panel_t s_panel = {
    .init = lcd_init,
    .refresh = lcd_refresh,
    .draw_raw = lcd_draw_raw,
    .update_ota_progress = lcd_update_ota_progress,
    .sleep = lcd_off,
    .wake = lcd_wake,
    .off = lcd_off,
    .width = LCD_HEIGHT,
    .height = LCD_WIDTH,
    .bpp = 16,
    .model = "d1001",
    .color_mode = "fullcolor",
    .fast_refresh = true,
    .retains_image = false,
    /* esp_lv_adapter owns the LVGL tick timer. */
    .needs_tick_timer = false,
    /* Pre-generated rather than LVGL's built-ins, whose glyph range is fixed at
     * ASCII and cannot be extended: an em dash in a status message drew as an
     * empty box, and any European accent would do the same. See
     * assets/render-fonts.sh for the range and its cost. */
    .font_lg = &vellum_font_montserrat_48,
    .font_md = &vellum_font_montserrat_32,
    .font_sm = &vellum_font_montserrat_24,
    .font_xs = &vellum_font_montserrat_16,
};

const vellum_panel_t *vellum_panel(void)
{
    /* lv_color_t isn't a constant expression — set the (dark) theme here. */
    s_panel.bg    = lv_color_black();
    s_panel.fg    = lv_color_white();
    s_panel.muted = lv_color_hex(0x999999);
    s_panel.dim   = lv_color_hex(0x666666);
    s_panel.logo  = &vellum_logo_color_360px;
    return &s_panel;
}
