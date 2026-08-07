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

    /* Flex column, fully centered */
    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(scr, 20, 0);

    add_logo(scr);

    lv_obj_t *ver = lv_label_create(scr);
    const esp_app_desc_t *app = esp_app_get_description();
    char ver_str[80];
    snprintf(ver_str, sizeof(ver_str), "%s | %s", app->version, p->model);
    lv_label_set_text(ver, ver_str);
    lv_obj_set_style_text_font(ver, p->font_xs, 0);
    lv_obj_set_style_text_color(ver, p->muted, 0);

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
        add_logo(left);

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

        add_logo(scr);

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

    add_logo(scr);

    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text_fmt(lbl, "Connecting to %s...", ssid);
    lv_obj_set_style_text_font(lbl, p->font_md, 0);
    lv_obj_set_style_text_color(lbl, p->muted, 0);

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
            lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
            /* Keep the complete status group centred. START pinned the logo to
             * y=0 on the tall E1003 panel. */
            lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER,
                                  LV_FLEX_ALIGN_CENTER);
            lv_obj_set_style_pad_row(scr, p->height > 1000 ? 32 : 12, 0);

            add_logo(scr);

            s_ota_title = lv_label_create(scr);
            lv_obj_set_width(s_ota_title, p->width / 2);
            lv_obj_set_style_text_align(s_ota_title, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_style_bg_color(s_ota_title, p->bg, 0);
            lv_obj_set_style_bg_opa(s_ota_title, LV_OPA_COVER, 0);
            lv_label_set_text(s_ota_title, "Updating firmware...");
            lv_obj_set_style_text_font(s_ota_title, p->font_md, 0);
            lv_obj_set_style_text_color(s_ota_title, p->fg, 0);

            s_ota_bar = lv_bar_create(scr);
            lv_obj_set_size(s_ota_bar, p->width / 2, p->height > 1000 ? 40 : 24);

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

            s_ota_warning = lv_label_create(scr);
            lv_obj_set_width(s_ota_warning, p->width / 2);
            lv_obj_set_style_text_align(s_ota_warning, LV_TEXT_ALIGN_CENTER, 0);
            lv_obj_set_style_bg_color(s_ota_warning, p->bg, 0);
            lv_obj_set_style_bg_opa(s_ota_warning, LV_OPA_COVER, 0);
            lv_label_set_text(s_ota_warning, "Do not power off");
            lv_obj_set_style_text_font(s_ota_warning, p->font_xs, 0);
            lv_obj_set_style_text_color(s_ota_warning, p->muted, 0);
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
        lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_set_style_pad_row(scr, 20, 0);

        add_logo(scr);

        lv_obj_t *title = lv_label_create(scr);
        lv_label_set_text(title, "Updating firmware...");
        lv_obj_set_style_text_font(title, p->font_lg, 0);
        lv_obj_set_style_text_color(title, p->fg, 0);

        lv_obj_t *warn = lv_label_create(scr);
        lv_label_set_text(warn, "Do not power off");
        lv_obj_set_style_text_font(warn, p->font_sm, 0);
        lv_obj_set_style_text_color(warn, p->muted, 0);

        lvgl_refresh();
    }
}

void display_show_error(const char *message)
{
    if (!s_lvgl_disp) return;
    const vellum_panel_t *p = vellum_panel();
    char screen_id[64];
    snprintf(screen_id, sizeof(screen_id), "error:%s", message);
    if (screen_unchanged(screen_id)) return;
    lv_obj_t *scr = lv_screen_active();
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, p->bg, 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(scr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(scr, 20, 0);
    lv_obj_set_style_pad_top(scr, 50, 0);

    lv_obj_t *logo = add_logo(scr);
    if (logo) lv_obj_set_style_pad_bottom(logo, 100, 0);

    lv_obj_t *icon = lv_label_create(scr);
    lv_label_set_text(icon, LV_SYMBOL_WARNING);
    lv_obj_set_style_text_font(icon, p->font_lg, 0);
    lv_obj_set_style_text_color(icon, lv_color_hex(0xCC0000), 0);

    lv_obj_t *lbl = lv_label_create(scr);
    lv_label_set_text(lbl, message);
    lv_obj_set_style_text_font(lbl, p->font_lg, 0);
    lv_obj_set_style_text_color(lbl, p->fg, 0);
    lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_width(lbl, p->width * 3 / 4);

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
