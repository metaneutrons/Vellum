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
  /* High-res (E1003: 1404px short side).
   *
   * All four rungs used to be 48px, i.e. the same absolute glyph size as the
   * 480px models — about a third of the intended optical size on this panel, and
   * with no distinction left between LG, MD and SM for the status screens to step
   * through.
   *
   * All four rungs are pre-generated assets (fonts/, assets/render-fonts.sh):
   * the top two because LVGL's bundled Montserrat stops at 48, the lower two
   * because its glyph range is ASCII-only and cannot be widened. They carry
   * Latin-1, Latin Extended-A, the dash family, European quotes and the six
   * LV_SYMBOL_* glyphs vellum_display_icon_t can show — a symbol outside that set
   * renders as a missing glyph. */
  extern const lv_font_t vellum_font_montserrat_96;
  extern const lv_font_t vellum_font_montserrat_64;
  #define FONT_LG   (&vellum_font_montserrat_96)
  #define FONT_MD   (&vellum_font_montserrat_64)
  extern const lv_font_t vellum_font_montserrat_48;
  extern const lv_font_t vellum_font_montserrat_24;
  #define FONT_SM   (&vellum_font_montserrat_48)
  #define FONT_XS   (&vellum_font_montserrat_24)
#else
  /* Standard (E1001/E1002: 480px short side) */
  extern const lv_font_t vellum_font_montserrat_48;
  extern const lv_font_t vellum_font_montserrat_24;
  extern const lv_font_t vellum_font_montserrat_18;
  extern const lv_font_t vellum_font_montserrat_14;
  #define FONT_LG   (&vellum_font_montserrat_48)
  #define FONT_MD   (&vellum_font_montserrat_24)
  #define FONT_SM   (&vellum_font_montserrat_18)
  #define FONT_XS   (&vellum_font_montserrat_14)
#endif

/* ── Logo (selected at compile time) ──────────────────────────── */
#if defined(CONFIG_VELLUM_PANEL_E1003)
extern const lv_img_dsc_t vellum_logo_16grey_600px;
#define LOGO_DSC (&vellum_logo_16grey_600px)
#elif defined(CONFIG_VELLUM_PANEL_GDEP073E01)
extern const lv_img_dsc_t vellum_logo_spectra_216px;
#define LOGO_DSC (&vellum_logo_spectra_216px)
#else
extern const lv_img_dsc_t vellum_logo_mono_216px;
#define LOGO_DSC (&vellum_logo_mono_216px)
#endif

static epd_handle_t s_epd = NULL;
static lv_display_t *s_disp = NULL;

/* ── IT8951 LVGL flush ────────────────────────────────────────── */
#if defined(CONFIG_VELLUM_PANEL_E1003)
static lv_area_t s_dirty_area;
static bool s_dirty_area_valid = false;

/* IT8951 consumes packed 4bpp pixels as 16-bit words.  A transfer must
 * therefore start on a four-pixel boundary and contain a multiple of four
 * pixels per row.  Expand LVGL's invalidated area before rendering so the
 * added neighbouring pixels are freshly drawn as well. */
#define IT8951_PIXELS_PER_WORD 4

static void it8951_rounder_cb(lv_event_t *event)
{
    lv_area_t *area = lv_event_get_invalidated_area(event);
    area->x1 &= ~(IT8951_PIXELS_PER_WORD - 1);
    area->x2 = LV_MIN(PANEL_WIDTH - 1,
                      area->x2 | (IT8951_PIXELS_PER_WORD - 1));
}

static void it8951_lvgl_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    const int32_t w = area->x2 - area->x1 + 1;
    const int32_t h = area->y2 - area->y1 + 1;
    const size_t src_stride = lv_draw_buf_width_to_stride(w, LV_COLOR_FORMAT_L8);
    const size_t dst_stride = (size_t)w / 2;
    const size_t buf_size = dst_stride * h;
    uint8_t *buf = heap_caps_malloc(buf_size, MALLOC_CAP_SPIRAM);
    bool loaded = false;

    if (buf) {
        for (int32_t y = 0; y < h; y++) {
            const uint8_t *src = px_map + (size_t)y * src_stride;
            uint8_t *dst = buf + (size_t)y * dst_stride;
            for (int32_t x = 0; x < w; x += 2) {
                dst[x / 2] = (src[x] & 0xF0) | (src[x + 1] >> 4);
            }
        }
        loaded = it8951_load_image_4bpp(buf, area->x1, area->y1, w, h) == ESP_OK;
        heap_caps_free(buf);
    } else {
        ESP_LOGE(TAG, "Cannot allocate %zu-byte IT8951 flush buffer", buf_size);
    }

    if (loaded && !s_dirty_area_valid) {
        s_dirty_area = *area;
        s_dirty_area_valid = true;
    } else if (loaded) {
        s_dirty_area.x1 = LV_MIN(s_dirty_area.x1, area->x1);
        s_dirty_area.y1 = LV_MIN(s_dirty_area.y1, area->y1);
        s_dirty_area.x2 = LV_MAX(s_dirty_area.x2, area->x2);
        s_dirty_area.y2 = LV_MAX(s_dirty_area.y2, area->y2);
    }
    if (lv_display_flush_is_last(disp)) {
        if (s_dirty_area_valid) {
            it8951_display_area(s_dirty_area.x1, s_dirty_area.y1,
                                s_dirty_area.x2 - s_dirty_area.x1 + 1,
                                s_dirty_area.y2 - s_dirty_area.y1 + 1, 2);
            s_dirty_area_valid = false;
        }
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
    lv_display_add_event_cb(s_disp, it8951_rounder_cb, LV_EVENT_INVALIDATE_AREA, NULL);
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

static void ep_sleep(void)
{
#if defined(CONFIG_VELLUM_PANEL_E1003)
    it8951_sleep();   /* put the IT8951 TCON into low-power sleep */
#else
    if (s_epd) epd_sleep(s_epd);
#endif
}

static void ep_wake(void)
{
#if defined(CONFIG_VELLUM_PANEL_E1003)
    it8951_wake();
#else
    if (s_epd) epd_wake(s_epd);
#endif
}

static void ep_off(void) { ep_sleep(); }

/* ── Panel descriptor ─────────────────────────────────────────── */


/* ── Palette and wire format (single source of truth) ─────────────
 *
 * These used to live a second time in http_client.c behind its own #if chain.
 * Two copies of the same hardware facts is how the reported geometry drifted
 * away from the driver, so the panel owns them now and the HTTP layer only
 * serialises what the panel reports.
 *
 * The wire colour mode is NOT the internal PANEL_COLORS: the E1002 calls itself
 * "color" internally but must advertise "indexed" to the server. Keeping both
 * spellings explicit avoids a silent mistranslation. */
#if defined(CONFIG_VELLUM_PANEL_GDEP073E01)
/* SIX-color Spectra, but SEVEN slots: the array position IS the on-wire pixel
 * code (EPD_PIXEL_*), so index 4 cannot be dropped or blue and green would slide
 * onto 0x4 and 0x5. Slot 4 holds a duplicate of WHITE — not orange, which exists
 * only on 7-color ACeP — so a server predating reservedPaletteIndices can never
 * emit 0x4, and it is reported reserved so a current server excludes it from
 * quantisation. Values mirror EPD_PIXEL_* deliberately rather than by include,
 * because the e-paper drivers are not built at all for the P4 target. */
static const uint8_t PANEL_PALETTE[][3] = {
    {  0,   0,   0},    /* 0x0 EPD_PIXEL_BLACK  */
    {255, 255, 255},    /* 0x1 EPD_PIXEL_WHITE  */
    {255, 255,   0},    /* 0x2 EPD_PIXEL_YELLOW */
    {255,   0,   0},    /* 0x3 EPD_PIXEL_RED    */
    {255, 255, 255},    /* 0x4 reserved         */
    {  0,   0, 255},    /* 0x5 EPD_PIXEL_BLUE   */
    {  0, 255,   0},    /* 0x6 EPD_PIXEL_GREEN  */
};
static const uint8_t PANEL_RESERVED[] = { 4 };
  #define PANEL_FORMAT     "raw"
  #define PANEL_WIRE_COLOR "indexed"
#elif defined(CONFIG_VELLUM_PANEL_GDEY075T7)
static const uint8_t PANEL_PALETTE[][3] = { {0,0,0}, {255,255,255} };
  #define PANEL_FORMAT     "raw"
  #define PANEL_WIRE_COLOR "mono"
#elif defined(CONFIG_VELLUM_PANEL_E1003)
/* 16 grays: i * 17, so 0, 17, 34 ... 255. */
static const uint8_t PANEL_PALETTE[][3] = {
    {  0,  0,  0},{ 17, 17, 17},{ 34, 34, 34},{ 51, 51, 51},
    { 68, 68, 68},{ 85, 85, 85},{102,102,102},{119,119,119},
    {136,136,136},{153,153,153},{170,170,170},{187,187,187},
    {204,204,204},{221,221,221},{238,238,238},{255,255,255},
};
  #define PANEL_FORMAT     "raw"
  #define PANEL_WIRE_COLOR "grayscale"
#endif

/* Every e-paper panel here is natively landscape and none of their drivers
 * rotates: the UC8179 config struct declares a `rotation` field that no .c file
 * ever reads, and the IT8951 hardwires rotate=0 into its LD_IMG_AREA argument.
 * One mounting is therefore the truth, not a shortcut in this list. */
static const char *const PANEL_ORIENTATIONS[] = { "landscape" };

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
    .image_format = PANEL_FORMAT,
    .wire_color_mode = PANEL_WIRE_COLOR,
    .palette = PANEL_PALETTE,
    .palette_count = (uint8_t)(sizeof(PANEL_PALETTE) / sizeof(PANEL_PALETTE[0])),
#if defined(CONFIG_VELLUM_PANEL_GDEP073E01)
    .reserved_palette_indices = PANEL_RESERVED,
    .reserved_count = (uint8_t)(sizeof(PANEL_RESERVED) / sizeof(PANEL_RESERVED[0])),
#endif
    .orientations = PANEL_ORIENTATIONS,
    .orientation_count = 1,
    .orientation = "landscape",
    .fast_refresh = PANEL_FAST_REFRESH,
    .retains_image = true,
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
#if defined(CONFIG_VELLUM_PANEL_GDEP073E01) || defined(CONFIG_VELLUM_PANEL_GDEY075T7)
    /* These panels have no reproducible gray ink. RGB 0x808080 is marginally
     * nearer to white than black in the palette converter and consequently made
     * firmware identity and secondary status copy disappear on the white
     * canvas. Keep semantic hierarchy through font size, but render every text
     * role in guaranteed black. */
    s_panel.muted = lv_color_black();
    s_panel.dim   = lv_color_black();
#else
    s_panel.muted = lv_color_hex(0x808080);
    s_panel.dim   = lv_color_hex(0xAAAAAA);
#endif
    return &s_panel;
}
