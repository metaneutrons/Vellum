/**
 * @file vellum_display.c
 * @brief Display abstraction layer — delegates to the active driver.
 */

#include "vellum_display.h"
#include "display_driver.h"
#include "fallback_icons.h"
#include "vellum_logo.h"
#include "qrcode.h"

#include <string.h>
#include <stdlib.h>
#include "esp_log.h"

static const char *TAG = "display";
static const display_driver_t *s_drv = NULL;

void display_init(void)
{
    s_drv = display_get_driver();
    ESP_LOGI(TAG, "Driver: %s (%dx%d, %d colors, %s)",
             s_drv->model, s_drv->width, s_drv->height,
             s_drv->palette_size, s_drv->quantize);
    s_drv->init();
}

bool display_draw_pixel_buffer(const uint8_t *buffer, size_t length)
{
    if (!buffer || !s_drv) return false;
    size_t expected = (size_t)s_drv->width * s_drv->height;
    if (length != expected) {
        ESP_LOGW(TAG, "Buffer size mismatch: %zu (expected %zu)", length, expected);
        return false;
    }
    return s_drv->draw(buffer, length) == ESP_OK;
}

void display_draw_fallback_icon(uint8_t icon_id)
{
    if (!s_drv || icon_id >= FALLBACK_ICON_COUNT) return;
    int ox = (s_drv->width - ICON_BITMAP_WIDTH) / 2;
    int oy = (s_drv->height - ICON_BITMAP_HEIGHT) / 2;
    s_drv->draw_bitmap(fallback_icons[icon_id], ICON_BITMAP_WIDTH, ICON_BITMAP_HEIGHT, ox, oy);
}

static void display_qr_callback(esp_qrcode_handle_t qrcode, void *user_data)
{
    (void)user_data;
    int qr_size = esp_qrcode_get_size(qrcode);

    /* Scale QR to fit display height with margin */
    int margin = 40;
    int max_dim = s_drv->height - margin * 2;
    int scale = max_dim / qr_size;
    if (scale < 1) scale = 1;
    int qr_px = qr_size * scale;

    /* Allocate framebuffer — palette index per pixel */
    size_t fb_len = (size_t)s_drv->width * s_drv->height;
    uint8_t *fb = malloc(fb_len);
    if (!fb) return;
    memset(fb, 1, fb_len); /* White background */

    /* Center QR code */
    int qr_ox = (s_drv->width - qr_px) / 2;
    int qr_oy = (s_drv->height - qr_px) / 2;

    for (int y = 0; y < qr_size; y++) {
        for (int x = 0; x < qr_size; x++) {
            if (esp_qrcode_get_module(qrcode, x, y)) {
                for (int sy = 0; sy < scale; sy++) {
                    for (int sx = 0; sx < scale; sx++) {
                        int px = qr_ox + x * scale + sx;
                        int py = qr_oy + y * scale + sy;
                        if (px >= 0 && px < s_drv->width && py >= 0 && py < s_drv->height) {
                            fb[py * s_drv->width + px] = 0; /* Black */
                        }
                    }
                }
            }
        }
    }

    /* Draw small Vellum logo in bottom-left corner */
    int logo_ox = 8;
    int logo_oy = s_drv->height - LOGO_SMALL_HEIGHT - 8;
    for (int y = 0; y < LOGO_SMALL_HEIGHT; y++) {
        for (int x = 0; x < LOGO_SMALL_WIDTH; x++) {
            int src_byte = y * (LOGO_SMALL_WIDTH / 8) + (x / 8);
            int src_bit = 7 - (x % 8);
            if (logo_small[src_byte] & (1 << src_bit)) {
                int dx = logo_ox + x;
                int dy = logo_oy + y;
                if (dx >= 0 && dx < s_drv->width && dy >= 0 && dy < s_drv->height) {
                    fb[dy * s_drv->width + dx] = 0;
                }
            }
        }
    }

    s_drv->draw(fb, fb_len);
    free(fb);
}

void display_draw_qr_code(const char *data)
{
    if (!s_drv) return;
    ESP_LOGI(TAG, "QR code: %s", data);

    esp_qrcode_config_t cfg = {
        .display_func_with_cb = display_qr_callback,
        .max_qrcode_version = 10,
        .qrcode_ecc_level = ESP_QRCODE_ECC_MED,
        .user_data = NULL,
    };
    if (esp_qrcode_generate(&cfg, data) != ESP_OK) {
        ESP_LOGW(TAG, "QR generation failed");
        display_draw_fallback_icon(ICON_ERROR);
    }
}

void display_show_loading(void)
{
    ESP_LOGI(TAG, "Loading...");
    /* TODO: Partial update with loading indicator */
}

void display_show_boot_logo(void)
{
    if (!s_drv) return;
    int ox = (s_drv->width - LOGO_BOOT_WIDTH) / 2;
    int oy = (s_drv->height - LOGO_BOOT_HEIGHT) / 2;
    s_drv->draw_bitmap(logo_boot, LOGO_BOOT_WIDTH, LOGO_BOOT_HEIGHT, ox, oy);
}


void display_show_ota_screen(void)
{
    if (!s_drv) return;
    ESP_LOGI(TAG, "Showing OTA update screen");

    /* Compose: logo centered upper third, text centered below */
    int logo_x = (s_drv->width - LOGO_BOOT_WIDTH) / 2;
    int logo_y = (s_drv->height / 2) - LOGO_BOOT_HEIGHT - 20;

    int line1_x = (s_drv->width - OTA_LINE1_WIDTH) / 2;
    int line1_y = (s_drv->height / 2) + 10;

    int line2_x = (s_drv->width - OTA_LINE2_WIDTH) / 2;
    int line2_y = line1_y + OTA_LINE1_HEIGHT + 8;

    /* Draw logo */
    s_drv->draw_bitmap(logo_boot, LOGO_BOOT_WIDTH, LOGO_BOOT_HEIGHT, logo_x, logo_y);

    /* For text, we need to composite onto the existing framebuffer.
     * Since draw_bitmap clears the screen, we draw all three in one pass
     * using a full framebuffer. */
    size_t fb_len = (size_t)s_drv->width * s_drv->height;
    uint8_t *fb = malloc(fb_len);
    if (!fb) return;
    memset(fb, 1, fb_len); /* White */

    /* Blit logo */
    for (int y = 0; y < LOGO_BOOT_HEIGHT; y++) {
        for (int x = 0; x < LOGO_BOOT_WIDTH; x++) {
            int sb = y * (LOGO_BOOT_WIDTH / 8) + (x / 8);
            if (logo_boot[sb] & (1 << (7 - (x % 8)))) {
                int dx = logo_x + x, dy = logo_y + y;
                if (dx >= 0 && dx < s_drv->width && dy >= 0 && dy < s_drv->height)
                    fb[dy * s_drv->width + dx] = 0;
            }
        }
    }

    /* Blit "Updating firmware..." */
    for (int y = 0; y < OTA_LINE1_HEIGHT; y++) {
        for (int x = 0; x < OTA_LINE1_WIDTH; x++) {
            int sb = y * ((OTA_LINE1_WIDTH + 7) / 8) + (x / 8);
            if (ota_line1[sb] & (1 << (7 - (x % 8)))) {
                int dx = line1_x + x, dy = line1_y + y;
                if (dx >= 0 && dx < s_drv->width && dy >= 0 && dy < s_drv->height)
                    fb[dy * s_drv->width + dx] = 0;
            }
        }
    }

    /* Blit "Do not power off." */
    for (int y = 0; y < OTA_LINE2_HEIGHT; y++) {
        for (int x = 0; x < OTA_LINE2_WIDTH; x++) {
            int sb = y * ((OTA_LINE2_WIDTH + 7) / 8) + (x / 8);
            if (ota_line2[sb] & (1 << (7 - (x % 8)))) {
                int dx = line2_x + x, dy = line2_y + y;
                if (dx >= 0 && dx < s_drv->width && dy >= 0 && dy < s_drv->height)
                    fb[dy * s_drv->width + dx] = 0;
            }
        }
    }

    s_drv->draw(fb, fb_len);
    free(fb);
}

void display_refresh(void)
{
    if (s_drv) s_drv->refresh();
}

void display_sleep(void)
{
    if (s_drv) s_drv->sleep();
}
