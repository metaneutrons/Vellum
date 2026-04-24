/**
 * @file vellum_display.c
 * @brief Display abstraction layer — delegates to the active driver.
 */

#include "vellum_display.h"
#include "display_driver.h"
#include "fallback_icons.h"
#include "vellum_logo.h"

#include <string.h>
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

void display_draw_qr_code(const char *data)
{
    if (!s_drv) return;
    ESP_LOGI(TAG, "QR code: %s", data);
    /* TODO: Generate QR code bitmap with qrcodegen library */
    /* For now, show small Vellum logo in bottom-left */
    int ox = 8;
    int oy = s_drv->height - LOGO_SMALL_HEIGHT - 8;
    s_drv->draw_bitmap(logo_small, LOGO_SMALL_WIDTH, LOGO_SMALL_HEIGHT, ox, oy);
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

void display_refresh(void)
{
    if (s_drv) s_drv->refresh();
}

void display_sleep(void)
{
    if (s_drv) s_drv->sleep();
}
