// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_display.c
 * @brief Backend-agnostic display layer: public API + local LVGL screens.
 *
 * All screen drawing (boot, Wi-Fi setup, OTA, errors) lives here once and runs
 * on every panel. Hardware specifics (init, refresh, raw draw, geometry, theme,
 * fonts, logo) arrive through the vellum_panel_t vtable, implemented per target
 * by panel_epaper.c (ESP32-S3) or panel_lcd.c (ESP32-P4). No #ifdefs here.
 */

#include "vellum_display.h"
#include "vellum_panel.h"
#include "status_layout.h"

#include <string.h>
#include "lvgl.h"
#include "qrcode.h"
#include "nvs_manager.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_app_desc.h"

static const char *TAG = "display";

static lv_display_t *s_lvgl_disp = NULL;
static char s_last_screen[64] = {0};
static lv_obj_t *s_ota_title = NULL;
static lv_obj_t *s_ota_bar = NULL;
static lv_obj_t *s_ota_percent = NULL;
static lv_obj_t *s_ota_warning = NULL;

static void lvgl_tick_cb(void *arg) { (void)arg; lv_tick_inc(5); }

/** Check if the screen already shows this content — skip refresh if so. */
static bool screen_unchanged(const char *screen_id)
{
    char stored[64] = {0};
    nvs_manager_get_str("last_scr", stored, sizeof(stored));
    if (strcmp(stored, screen_id) == 0 && strcmp(s_last_screen, screen_id) == 0) {
        ESP_LOGI(TAG, "Screen unchanged (%s) — skipping refresh", screen_id);
        return true;
    }
    strlcpy(s_last_screen, screen_id, sizeof(s_last_screen));
    nvs_manager_set_str("last_scr", screen_id);
    return false;
}

static void lvgl_refresh(void)
{
    if (!s_lvgl_disp) return;
    vellum_panel()->refresh();
}

static lv_obj_t *add_logo(lv_obj_t *parent)
{
    const lv_img_dsc_t *logo = vellum_panel()->logo;
    if (!logo) return NULL;
    lv_obj_t *img = lv_image_create(parent);
    lv_image_set_src(img, logo);
    return img;
}

/* Every branded transient/status screen uses this anchor. Do not centre logo
 * and content as one flex group: a longer error message would otherwise move
 * the Vellum mark to a different height. */
/* The vertical grid lives in status_layout.c: pure arithmetic, no LVGL, so the
 * host tests exercise the real thing instead of a copy. Logo assets are
 * pre-rendered at 45% of the panel height (assets/render-logos.sh) — no runtime
 * scaling, which on 1-bit e-paper would be visibly nearest-neighbour. */
static int status_logo_top(const vellum_panel_t *p)
{
    return status_layout_logo_top(p->height);
}

static int firmware_identity_gap(const vellum_panel_t *p)
{
    return status_layout_identity_gap(p->height);
}

static int status_content_top(const vellum_panel_t *p)
{
    int logo_h = p->logo ? p->logo->header.h : 0;
    return status_layout_content_top(p->height, logo_h, p->font_xs->line_height);
}

/* Rough wrap estimate for font selection. LVGL can only measure once the label
 * exists, and by then the font is already chosen; a conservative average glyph
 * width of 0.55em errs toward the smaller font rather than toward drawing
 * off-screen. Explicit newlines are honoured. */
static int estimate_lines(const char *text, const lv_font_t *font, int width)
{
    if (!text || !font || width <= 0) return 1;
    int per_line = width / (font->line_height * 55 / 100);
    if (per_line < 1) per_line = 1;
    int lines = 1, run = 0;
    for (const char *c = text; *c; c++) {
        if (*c == '\n') { lines++; run = 0; continue; }
        if (++run > per_line) { lines++; run = 1; }
    }
    return lines;
}

static lv_obj_t *add_firmware_identity(lv_obj_t *parent)
{
    const vellum_panel_t *p = vellum_panel();
    const esp_app_desc_t *app = esp_app_get_description();
    lv_obj_t *identity = lv_label_create(parent);
    char text[80];
    snprintf(text, sizeof(text), "%s | %s", app->version, p->model);
    lv_label_set_text(identity, text);
    lv_obj_set_style_text_font(identity, p->font_xs, 0);
    lv_obj_set_style_text_color(identity, p->muted, 0);
    lv_obj_set_style_text_align(identity, LV_TEXT_ALIGN_CENTER, 0);
    return identity;
}

static lv_obj_t *add_status_logo(lv_obj_t *parent)
{
    const vellum_panel_t *p = vellum_panel();
    lv_obj_t *logo = add_logo(parent);
    if (logo) lv_obj_align(logo, LV_ALIGN_TOP_MID, 0, status_logo_top(p));

    lv_obj_t *identity = add_firmware_identity(parent);
    int logo_h = p->logo ? p->logo->header.h : 0;
    lv_obj_align(identity, LV_ALIGN_TOP_MID, 0,
                 status_logo_top(p) + logo_h + firmware_identity_gap(p));
    return logo;
}

/** A self-contained mark for flex layouts, with the same logo/version spacing
 * used by absolute-positioned status screens on every display model. */
static lv_obj_t *add_branded_mark(lv_obj_t *parent)
{
    const vellum_panel_t *p = vellum_panel();
    const int logo_w = p->logo ? p->logo->header.w : 0;
    const int logo_h = p->logo ? p->logo->header.h : 0;
    lv_obj_t *mark = lv_obj_create(parent);
    lv_obj_remove_style_all(mark);
    lv_obj_set_size(mark, logo_w, logo_h + firmware_identity_gap(p) + p->font_xs->line_height);
    lv_obj_set_flex_flow(mark, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(mark, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(mark, firmware_identity_gap(p), 0);
    add_logo(mark);
    add_firmware_identity(mark);
    return mark;
}

/* ── Init ─────────────────────────────────────────────────────── */

esp_err_t display_init(void)
{
    const vellum_panel_t *p = vellum_panel();

    s_lvgl_disp = p->init();
    if (!s_lvgl_disp) {
        ESP_LOGW(TAG, "LVGL display init failed — local screens unavailable");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Panel: %s (%dx%d, %d bpp, %s)", p->model,
             p->width, p->height, p->bpp, p->color_mode);

    if (p->needs_tick_timer) {
        /* Drive the LVGL tick via esp_timer (no background handler task). */
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
    const vellum_panel_t *p = vellum_panel();
    info->model = p->model;
    info->width = p->width;
    info->height = p->height;
    info->bpp = p->bpp;
    info->color_mode = p->color_mode;
    return ESP_OK;
}

/* ── Local mode: LVGL screens ─────────────────────────────────── */

void display_show_boot(const char *version)
{
    (void)version;
    if (!s_lvgl_disp) return;
    const vellum_panel_t *p = vellum_panel();
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_layout(scr, LV_LAYOUT_NONE);

    add_status_logo(scr);

    lvgl_refresh();
}

static int s_qr_canvas_size = 200;

static void qr_display_cb(esp_qrcode_handle_t qrcode, void *user_data)
{
    const vellum_panel_t *p = vellum_panel();
    lv_obj_t *canvas = (lv_obj_t *)user_data;
    int qr_size = esp_qrcode_get_size(qrcode);
    int scale = s_qr_canvas_size / qr_size;
    if (scale < 1) scale = 1;

    lv_canvas_fill_bg(canvas, p->bg, LV_OPA_COVER);

    for (int y = 0; y < qr_size; y++) {
        for (int x = 0; x < qr_size; x++) {
            if (esp_qrcode_get_module(qrcode, x, y)) {
                for (int sy = 0; sy < scale; sy++) {
                    for (int sx = 0; sx < scale; sx++) {
                        lv_canvas_set_px(canvas, x * scale + sx, y * scale + sy,
                                         p->fg, LV_OPA_COVER);
                    }
                }
            }
        }
    }
}

void display_show_wifi_setup(const char *ssid, const char *url)
{
    if (!s_lvgl_disp) return;
    const vellum_panel_t *p = vellum_panel();
    const int short_side = (p->width < p->height) ? p->width : p->height;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    int qr_size = short_side * 43 / 100;
    if (qr_size > 600) qr_size = 600;
    if (qr_size < 150) qr_size = 150;

    static lv_color_t *qr_buf = NULL;
    if (!qr_buf) qr_buf = heap_caps_malloc(qr_size * qr_size * sizeof(lv_color_t), MALLOC_CAP_SPIRAM);

    if (p->width > p->height) {
        /* ── Landscape: Logo left, QR+text right ──────────────── */
        lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_ROW);
        lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

        lv_obj_t *left = lv_obj_create(scr);
        lv_obj_remove_style_all(left);
        lv_obj_set_size(left, p->width / 2, p->height);
        lv_obj_set_flex_flow(left, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(left, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        add_branded_mark(left);

        lv_obj_t *right = lv_obj_create(scr);
        lv_obj_remove_style_all(right);
        lv_obj_set_size(right, p->width / 2, p->height);
        lv_obj_set_flex_flow(right, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(right, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_row(right, 15, 0);

        if (qr_buf) {
            lv_obj_t *canvas = lv_canvas_create(right);
            lv_canvas_set_buffer(canvas, qr_buf, qr_size, qr_size, LV_COLOR_FORMAT_NATIVE);
            esp_qrcode_config_t qr_cfg = { .display_func_with_cb = qr_display_cb, .max_qrcode_version = 10, .qrcode_ecc_level = ESP_QRCODE_ECC_MED, .user_data = canvas };
            s_qr_canvas_size = qr_size;
            esp_qrcode_generate(&qr_cfg, url);
        }

        lv_obj_t *lbl_ssid = lv_label_create(right);
        lv_label_set_text_fmt(lbl_ssid, "WiFi: %s", ssid);
        lv_obj_set_style_text_font(lbl_ssid, p->font_md, 0);
        lv_obj_set_style_text_color(lbl_ssid, p->fg, 0);

        lv_obj_t *lbl_hint = lv_label_create(right);
        lv_label_set_text(lbl_hint, "Scan QR to configure WiFi");
        lv_obj_set_style_text_font(lbl_hint, p->font_sm, 0);
        lv_obj_set_style_text_color(lbl_hint, p->muted, 0);
    } else {
        /* ── Portrait: vertical stack ─────────────────────────── */
        lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_row(scr, 20, 0);
        lv_obj_set_style_pad_top(scr, p->height / 12, 0);

        add_branded_mark(scr);

        if (qr_buf) {
            lv_obj_t *canvas = lv_canvas_create(scr);
            lv_canvas_set_buffer(canvas, qr_buf, qr_size, qr_size, LV_COLOR_FORMAT_NATIVE);
            esp_qrcode_config_t qr_cfg = { .display_func_with_cb = qr_display_cb, .max_qrcode_version = 10, .qrcode_ecc_level = ESP_QRCODE_ECC_MED, .user_data = canvas };
            s_qr_canvas_size = qr_size;
            esp_qrcode_generate(&qr_cfg, url);
        }

        lv_obj_t *lbl_ssid = lv_label_create(scr);
        lv_label_set_text_fmt(lbl_ssid, "WiFi: %s", ssid);
        lv_obj_set_style_text_font(lbl_ssid, p->font_md, 0);
        lv_obj_set_style_text_color(lbl_ssid, p->fg, 0);
        lv_obj_set_style_text_align(lbl_ssid, LV_TEXT_ALIGN_CENTER, 0);

        lv_obj_t *lbl_hint = lv_label_create(scr);
        lv_label_set_text(lbl_hint, "Scan QR code to configure WiFi\nor use Vellum Console via USB.");
        lv_obj_set_style_text_font(lbl_hint, p->font_sm, 0);
        lv_obj_set_style_text_color(lbl_hint, p->muted, 0);
        lv_obj_set_style_text_align(lbl_hint, LV_TEXT_ALIGN_CENTER, 0);
        lv_obj_set_width(lbl_hint, p->width * 3 / 4);
    }

    lvgl_refresh();
}

void display_show_connecting(const char *ssid)
{
    const vellum_panel_t *p = vellum_panel();
    if (!p->fast_refresh) return;  /* slow e-paper: skip transient screen */
    if (!s_lvgl_disp) return;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(scr, 20, 0);

    add_branded_mark(scr);

    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text_fmt(lbl, "Connecting to %s...", ssid);
    lv_obj_set_style_text_font(lbl, p->font_md, 0);
    lv_obj_set_style_text_color(lbl, p->muted, 0);

    lvgl_refresh();
}

void display_show_wifi_error(const char *detail, uint32_t retry_after_seconds)
{
    if (!s_lvgl_disp) return;
    const vellum_panel_t *p = vellum_panel();
    char screen_id[96];
    snprintf(screen_id, sizeof(screen_id), "wifi-error:%s:%lu", detail ? detail : "",
             (unsigned long)retry_after_seconds);
    if (screen_unchanged(screen_id)) return;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_layout(scr, LV_LAYOUT_NONE);
    int content_top = status_content_top(p);
    int step = p->height > 1000 ? 88 : 44;

    add_status_logo(scr);

    lv_obj_t *icon = lv_label_create(scr);
    lv_label_set_text(icon, LV_SYMBOL_WARNING);
    lv_obj_set_style_text_font(icon, p->font_lg, 0);
    lv_obj_set_style_text_color(icon, lv_color_hex(0xCC0000), 0);
    lv_obj_align(icon, LV_ALIGN_TOP_MID, 0, content_top);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "Wi-Fi unavailable");
    lv_obj_set_style_text_font(title, p->font_lg, 0);
    lv_obj_set_style_text_color(title, p->fg, 0);
    lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(title, p->width * 3 / 4);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, content_top + step);

    lv_obj_t *reason = lv_label_create(scr);
    lv_label_set_text(reason, detail && detail[0] ? detail : "Could not join saved Wi-Fi");
    lv_obj_set_style_text_font(reason, p->font_md, 0);
    lv_obj_set_style_text_color(reason, p->muted, 0);
    lv_obj_set_style_text_align(reason, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(reason, p->width * 3 / 4);
    lv_obj_align(reason, LV_ALIGN_TOP_MID, 0, content_top + step * 2);

    uint32_t minutes = (retry_after_seconds + 59) / 60;
    char retry[80];
    snprintf(retry, sizeof(retry), "Retrying automatically\nin about %lu minute%s",
             (unsigned long)minutes, minutes == 1 ? "" : "s");
    lv_obj_t *hint = lv_label_create(scr);
    lv_label_set_text(hint, retry);
    lv_obj_set_style_text_font(hint, p->font_sm, 0);
    lv_obj_set_style_text_color(hint, p->muted, 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(hint, p->width * 3 / 4);
    lv_obj_align(hint, LV_ALIGN_TOP_MID, 0, content_top + step * 3);

    lvgl_refresh();
}

void display_show_ota_progress(uint8_t percent)
{
    if (!s_lvgl_disp) return;
    const vellum_panel_t *p = vellum_panel();
    lv_obj_t *scr = lv_screen_active();

    if (p->fast_refresh) {
        if (!s_ota_title || !lv_obj_is_valid(s_ota_title) ||
            !s_ota_bar || !lv_obj_is_valid(s_ota_bar) ||
            !s_ota_percent || !lv_obj_is_valid(s_ota_percent)) {
            lv_obj_clean(scr);
            lv_obj_set_style_bg_color(scr, p->bg, 0);
            lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
            lv_obj_set_layout(scr, LV_LAYOUT_NONE);
            int content_top = status_content_top(p);
            int step = p->height > 1000 ? 72 : 36;

            add_status_logo(scr);

            s_ota_title = lv_label_create(scr);
            lv_obj_set_width(s_ota_title, p->width / 2);
            lv_obj_set_style_text_align(s_ota_title, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_style_bg_color(s_ota_title, p->bg, 0);
            lv_obj_set_style_bg_opa(s_ota_title, LV_OPA_COVER, 0);
            lv_label_set_text(s_ota_title, "Updating firmware...");
            lv_obj_set_style_text_font(s_ota_title, p->font_md, 0);
            lv_obj_set_style_text_color(s_ota_title, p->fg, 0);
            lv_obj_align(s_ota_title, LV_ALIGN_TOP_MID, 0, content_top);

            s_ota_bar = lv_bar_create(scr);
            lv_obj_set_size(s_ota_bar, p->width / 2, p->height > 1000 ? 40 : 24);
            lv_obj_align(s_ota_bar, LV_ALIGN_TOP_MID, 0, content_top + step);

            s_ota_percent = lv_label_create(scr);
            /* Fixed opaque bounds are important on e-paper: variable-width
             * strings such as "5%" -> "10%" otherwise leave stale glyph pixels
             * behind during a partial refresh. */
            lv_obj_set_width(s_ota_percent, p->height > 1000 ? 240 : 120);
            lv_obj_set_style_text_align(s_ota_percent, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_style_bg_color(s_ota_percent, p->bg, 0);
            lv_obj_set_style_bg_opa(s_ota_percent, LV_OPA_COVER, 0);
            lv_obj_set_style_text_font(s_ota_percent, p->font_md, 0);
            lv_obj_set_style_text_color(s_ota_percent, p->fg, 0);
            lv_obj_align(s_ota_percent, LV_ALIGN_TOP_MID, 0, content_top + step * 2);

            s_ota_warning = lv_label_create(scr);
            lv_obj_set_width(s_ota_warning, p->width / 2);
            lv_obj_set_style_text_align(s_ota_warning, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_style_bg_color(s_ota_warning, p->bg, 0);
            lv_obj_set_style_bg_opa(s_ota_warning, LV_OPA_COVER, 0);
            lv_label_set_text(s_ota_warning, "Do not power off");
            lv_obj_set_style_text_font(s_ota_warning, p->font_xs, 0);
            lv_obj_set_style_text_color(s_ota_warning, p->muted, 0);
            lv_obj_align(s_ota_warning, LV_ALIGN_TOP_MID, 0, content_top + step * 3);
        }

        lv_bar_set_value(s_ota_bar, percent, LV_ANIM_OFF);
        lv_label_set_text_fmt(s_ota_percent, "%d%%", percent);
        if (percent == 100) {
            lv_label_set_text(s_ota_title, "Firmware updated");
            if (s_ota_warning && lv_obj_is_valid(s_ota_warning)) {
                lv_label_set_text(s_ota_warning, "Restarting...");
            }
        }

        lvgl_refresh();
    } else {
        /* Slow display: single static screen, no progress updates */
        (void)percent;
        if (screen_unchanged("ota")) return;

        lv_obj_clean(scr);
        lv_obj_set_style_bg_color(scr, p->bg, 0);
        lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
        lv_obj_set_layout(scr, LV_LAYOUT_NONE);
        int content_top = status_content_top(p);
        int step = p->height > 1000 ? 84 : 42;

        add_status_logo(scr);

        lv_obj_t *title = lv_label_create(scr);
        lv_label_set_text(title, "Updating firmware...");
        lv_obj_set_style_text_font(title, p->font_lg, 0);
        lv_obj_set_style_text_color(title, p->fg, 0);
        lv_obj_align(title, LV_ALIGN_TOP_MID, 0, content_top);

        lv_obj_t *warn = lv_label_create(scr);
        lv_label_set_text(warn, "Do not power off");
        lv_obj_set_style_text_font(warn, p->font_sm, 0);
        lv_obj_set_style_text_color(warn, p->muted, 0);
        lv_obj_align(warn, LV_ALIGN_TOP_MID, 0, content_top + step);

        lvgl_refresh();
    }
}

/* Glyph for each icon. NULL means "draw no icon row at all", which is what
 * distinguishes an informational screen from a fault. */
static const char *icon_glyph(vellum_display_icon_t icon)
{
    switch (icon) {
        case VD_ICON_WARNING: return LV_SYMBOL_WARNING;
        case VD_ICON_BATTERY: return LV_SYMBOL_BATTERY_EMPTY;
        case VD_ICON_WIFI:    return LV_SYMBOL_WIFI;
        case VD_ICON_SERVER:  return LV_SYMBOL_DRIVE;
        case VD_ICON_PENDING: return LV_SYMBOL_EYE_OPEN;
        case VD_ICON_REFRESH: return LV_SYMBOL_REFRESH;
        case VD_ICON_NONE:
        default:              return NULL;
    }
}

/* Red is reserved for states an operator must fix. A pending approval or a
 * deliberate in-progress step is drawn in the muted foreground, so the colour
 * carries the same message as the glyph. */
static lv_color_t icon_color(const vellum_panel_t *p, vellum_display_icon_t icon)
{
    switch (icon) {
        case VD_ICON_WARNING: return lv_color_hex(0xCC0000);
        case VD_ICON_PENDING:
        case VD_ICON_REFRESH: return p->muted;
        default:              return p->fg;
    }
}

void display_show_status_message(vellum_display_icon_t icon, const char *title,
                                 const char *detail)
{
    if (!s_lvgl_disp || !title) return;
    const vellum_panel_t *p = vellum_panel();

    char screen_id[128];
    snprintf(screen_id, sizeof(screen_id), "status:%d:%s:%s",
             (int)icon, title, detail ? detail : "");
    if (screen_unchanged(screen_id)) return;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_layout(scr, LV_LAYOUT_NONE);

    const int content_top = status_content_top(p);
    const int logo_h = p->logo ? p->logo->header.h : 0;
    const int text_w = p->width * 3 / 4;
    const int gap = p->height / 40;
    const char *glyph = icon_glyph(icon);
    const int icon_rows = glyph ? 1 : 0;

    add_status_logo(scr);

    /* Pick the largest rung whose whole block fits. The old screen forced
     * font_lg unconditionally, which is how a 480px panel ended up laying its
     * message out below its own bottom edge. The measurement below covers exactly
     * what the code after it draws: the icon row, the wrapped title, then the
     * detail one rung smaller. */
    const lv_font_t *const ladder[] = { p->font_lg, p->font_md, p->font_sm };
    const size_t rungs = sizeof(ladder) / sizeof(ladder[0]);
    const lv_font_t *title_font = ladder[0];
    const lv_font_t *detail_font = ladder[1];
    int title_lines = 1, detail_lines = 0;

    for (size_t i = 0; i < rungs; i++) {
        title_font = ladder[i];
        detail_font = ladder[i + 1 < rungs ? i + 1 : rungs - 1];
        title_lines = estimate_lines(title, title_font, text_w);
        detail_lines = detail ? estimate_lines(detail, detail_font, text_w) : 0;
        if (status_layout_fits(p->height, logo_h, p->font_xs->line_height,
                               icon_rows + title_lines, title_font->line_height,
                               detail_lines, detail_font->line_height, gap)) {
            break;
        }
    }

    /* Icon in the title's own size — the old screen drew a fixed 48px glyph at a
     * 150% transform, which reserved a block of its own regardless of panel. */
    if (glyph) {
        lv_obj_t *ico = lv_label_create(scr);
        lv_label_set_text(ico, glyph);
        lv_obj_set_style_text_font(ico, title_font, 0);
        lv_obj_set_style_text_color(ico, icon_color(p, icon), 0);
        lv_obj_align(ico, LV_ALIGN_TOP_MID, 0, content_top);
    }

    const int title_top = content_top + icon_rows * title_font->line_height;
    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, title);
    lv_obj_set_style_text_font(lbl, title_font, 0);
    lv_obj_set_style_text_color(lbl, p->fg, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_label_set_long_mode(lbl, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(lbl, text_w);
    lv_obj_align(lbl, LV_ALIGN_TOP_MID, 0, title_top);

    if (detail) {
        lv_obj_t *sub = lv_label_create(scr);
        lv_label_set_text(sub, detail);
        lv_obj_set_style_text_font(sub, detail_font, 0);
        lv_obj_set_style_text_color(sub, p->muted, 0);
        lv_obj_set_style_text_align(sub, LV_TEXT_ALIGN_CENTER, 0);
        lv_label_set_long_mode(sub, LV_LABEL_LONG_MODE_WRAP);
        lv_obj_set_width(sub, text_w);
        lv_obj_align(sub, LV_ALIGN_TOP_MID, 0,
                     title_top + title_lines * title_font->line_height + gap);
    }

    lvgl_refresh();
}

void display_show_error(const char *message)
{
    /* Kept so every existing caller keeps compiling; a caller that wants an
     * honest non-fault icon should call display_show_status_message() directly. */
    display_show_status_message(VD_ICON_WARNING, message, NULL);
}

void display_show_no_content(void)
{
    if (!s_lvgl_disp) return;
    const vellum_panel_t *p = vellum_panel();
    if (screen_unchanged("no-content")) return;

    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_layout(scr, LV_LAYOUT_NONE);
    add_status_logo(scr);

    const int content_top = status_content_top(p);
    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "No content assigned");
    lv_obj_set_style_text_font(title, p->font_lg, 0);
    lv_obj_set_style_text_color(title, p->fg, 0);
    lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(title, p->width * 3 / 4);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, content_top + (p->height > 1000 ? 90 : 54));

    lv_obj_t *hint = lv_label_create(scr);
    lv_label_set_text(hint, "Assign content in Vellum");
    lv_obj_set_style_text_font(hint, p->font_sm, 0);
    lv_obj_set_style_text_color(hint, p->muted, 0);
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(hint, p->width * 3 / 4);
    lv_obj_align(hint, LV_ALIGN_TOP_MID, 0, content_top + (p->height > 1000 ? 148 : 100));

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

    /* Clear last-screen marker — server content is always fresh. */
    s_last_screen[0] = '\0';
    nvs_manager_set_str("last_scr", "");

    return vellum_panel()->draw_raw(buffer, len);
}

/* ── Power management ─────────────────────────────────────────── */

esp_err_t display_sleep(void)
{
    const vellum_panel_t *p = vellum_panel();
    if (p->sleep) p->sleep();
    return ESP_OK;
}

esp_err_t display_wake(void)
{
    const vellum_panel_t *p = vellum_panel();
    if (p->wake) p->wake();
    return ESP_OK;
}

/* ── Unified API ──────────────────────────────────────────────── */

esp_err_t vellum_display_init(void)
{
    return display_init();
}

esp_err_t vellum_display_show_image(const uint8_t *data, size_t len, const char *format)
{
    (void)format; /* each backend knows its own buffer format */
    return display_update_raw(data, len);
}

esp_err_t vellum_display_show_status(const char *text)
{
    display_show_boot(text);
    return ESP_OK;
}

void vellum_display_off(void)
{
    const vellum_panel_t *p = vellum_panel();
    if (p->off) p->off();
}

int vellum_display_width(void)
{
    return vellum_panel()->width;
}

int vellum_display_height(void)
{
    return vellum_panel()->height;
}
