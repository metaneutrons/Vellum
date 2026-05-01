/**
 * @file epaper_registry.c
 * @brief Data-driven panel registry and controller lookup
 *
 * To add a new panel:
 * 1. Add enum in epaper_config.h
 * 2. Add entry in panel_registry[] below
 *
 * To add a new controller:
 * 1. Add enum in epaper_panel.h (epd_controller_type_t)
 * 2. Implement controller in src/controllers/
 * 3. Add entry in controller_ops[] below
 */

#include "epaper_panel.h"
#include "epaper_config.h"

/*=============================================================================
 * Controller Operations (forward declarations)
 *============================================================================*/

// SSD16xx generic BW controller
extern esp_err_t ssd16xx_init(epd_device_t *dev);
extern esp_err_t ssd16xx_update(epd_device_t *dev, epd_update_mode_t mode);
extern esp_err_t ssd16xx_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len);
extern esp_err_t ssd16xx_write_ram_partial(epd_device_t *dev, uint16_t x, uint16_t y,
                                            uint16_t w, uint16_t h, const uint8_t *data);
extern esp_err_t ssd16xx_sleep(epd_device_t *dev);
extern esp_err_t ssd16xx_wake(epd_device_t *dev);

// GDEY0154D67 with custom LUT
extern esp_err_t gdey0154_init(epd_device_t *dev);
extern esp_err_t gdey0154_update(epd_device_t *dev, epd_update_mode_t mode);
extern esp_err_t gdey0154_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len);
extern esp_err_t gdey0154_write_ram_partial(epd_device_t *dev, uint16_t x, uint16_t y,
                                             uint16_t w, uint16_t h, const uint8_t *data);
extern esp_err_t gdey0154_sleep(epd_device_t *dev);
extern esp_err_t gdey0154_wake(epd_device_t *dev);

// ACeP 6-color controller
extern esp_err_t acep6c_init(epd_device_t *dev);
extern esp_err_t acep6c_update(epd_device_t *dev, epd_update_mode_t mode);
extern esp_err_t acep6c_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len);
extern esp_err_t acep6c_sleep(epd_device_t *dev);
extern esp_err_t acep6c_wake(epd_device_t *dev);

// BWRY 4-color controller
extern esp_err_t bwry4c_init(epd_device_t *dev);
extern esp_err_t bwry4c_update(epd_device_t *dev, epd_update_mode_t mode);
extern esp_err_t bwry4c_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len);
extern esp_err_t bwry4c_sleep(epd_device_t *dev);
extern esp_err_t bwry4c_wake(epd_device_t *dev);

// UC8179 BW controller (GDEY075T7, 7.5" 800x480)
extern esp_err_t uc8179bw_init(epd_device_t *dev);
extern esp_err_t uc8179bw_update(epd_device_t *dev, epd_update_mode_t mode);
extern esp_err_t uc8179bw_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len);
extern esp_err_t uc8179bw_sleep(epd_device_t *dev);
extern esp_err_t uc8179bw_wake(epd_device_t *dev);

// ED103TC2 16-gray controller (10.3" 1404x1872)
extern esp_err_t ed103tc2_init(epd_device_t *dev);
extern esp_err_t ed103tc2_update(epd_device_t *dev, epd_update_mode_t mode);
extern esp_err_t ed103tc2_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len);
extern esp_err_t ed103tc2_sleep(epd_device_t *dev);
extern esp_err_t ed103tc2_wake(epd_device_t *dev);

/*=============================================================================
 * Controller Operations Table
 *============================================================================*/

static const epd_controller_ops_t controller_ops[EPD_CTRL_COUNT] = {
    [EPD_CTRL_SSD16XX] = {
        .init = ssd16xx_init,
        .update = ssd16xx_update,
        .write_ram = ssd16xx_write_ram,
        .write_ram_partial = ssd16xx_write_ram_partial,
        .sleep = ssd16xx_sleep,
        .wake = ssd16xx_wake,
    },
    [EPD_CTRL_GDEY0154_LUT] = {
        .init = gdey0154_init,
        .update = gdey0154_update,
        .write_ram = gdey0154_write_ram,
        .write_ram_partial = gdey0154_write_ram_partial,
        .sleep = gdey0154_sleep,
        .wake = gdey0154_wake,
    },
    [EPD_CTRL_ACEP_6COLOR] = {
        .init = acep6c_init,
        .update = acep6c_update,
        .write_ram = acep6c_write_ram,
        .write_ram_partial = NULL,  // Not supported
        .sleep = acep6c_sleep,
        .wake = acep6c_wake,
    },
    [EPD_CTRL_BWRY_4COLOR] = {
        .init = bwry4c_init,
        .update = bwry4c_update,
        .write_ram = bwry4c_write_ram,
        .write_ram_partial = NULL,  // Not supported
        .sleep = bwry4c_sleep,
        .wake = bwry4c_wake,
    },
    [EPD_CTRL_UC8179_BW] = {
        .init = uc8179bw_init,
        .update = uc8179bw_update,
        .write_ram = uc8179bw_write_ram,
        .write_ram_partial = NULL,
        .sleep = uc8179bw_sleep,
        .wake = uc8179bw_wake,
    },
    [EPD_CTRL_ED103TC2] = {
        .init = ed103tc2_init,
        .update = ed103tc2_update,
        .write_ram = ed103tc2_write_ram,
        .write_ram_partial = NULL,
        .sleep = ed103tc2_sleep,
        .wake = ed103tc2_wake,
    },
};

/*=============================================================================
 * Panel Registry Table
 *
 * Format: { name, width, height, color_mode, bpp, caps, controller, init_data }
 *============================================================================*/

static const epd_panel_desc_t panel_registry[EPD_PANEL_COUNT] = {
    // Specific panels with custom features
    [EPD_PANEL_GDEY0154D67] = {
        .name = "GDEY0154D67",
        .width = 200, .height = 200,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_GDEY0154_LUT,
        .init_data = NULL,
    },
    [EPD_PANEL_GDEP073E01] = {
        .name = "GDEP073E01",
        .width = 800, .height = 480,
        .color_mode = EPD_COLOR_6COLOR, .bits_per_pixel = 4,
        .caps = EPD_CAP_BUSY_INV,  // Inverted busy, no partial/fast
        .ctrl = EPD_CTRL_ACEP_6COLOR,
        .init_data = NULL,
    },
    [EPD_PANEL_GDEY037F51] = {
        .name = "GDEY037F51",
        .width = 240, .height = 416,
        .color_mode = EPD_COLOR_4COLOR, .bits_per_pixel = 2,
        .caps = EPD_CAP_BUSY_INV,  // No partial/fast support
        .ctrl = EPD_CTRL_BWRY_4COLOR,
        .init_data = NULL,
    },
    [EPD_PANEL_GDEY075T7] = {
        .name = "GDEY075T7",
        .width = 800, .height = 480,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_FAST,
        .ctrl = EPD_CTRL_UC8179_BW,
        .init_data = NULL,
    },
    [EPD_PANEL_ED103TC2] = {
        .name = "ED103TC2",
        .width = 1404, .height = 1872,
        .color_mode = EPD_COLOR_16GRAY, .bits_per_pixel = 4,
        .caps = EPD_CAP_FAST,
        .ctrl = EPD_CTRL_ED103TC2,
        .init_data = NULL,
    },

    // Generic SSD16xx BW panels (same controller, different sizes)
    [EPD_PANEL_SSD16XX_154] = {
        .name = "SSD16xx_154",
        .width = 200, .height = 200,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
    [EPD_PANEL_SSD16XX_213] = {
        .name = "SSD16xx_213",
        .width = 122, .height = 250,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
    [EPD_PANEL_SSD16XX_266] = {
        .name = "SSD16xx_266",
        .width = 152, .height = 296,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
    [EPD_PANEL_SSD16XX_270] = {
        .name = "SSD16xx_270",
        .width = 176, .height = 264,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
    [EPD_PANEL_SSD16XX_290] = {
        .name = "SSD16xx_290",
        .width = 128, .height = 296,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
    [EPD_PANEL_SSD16XX_370] = {
        .name = "SSD16xx_370",
        .width = 280, .height = 480,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
    [EPD_PANEL_SSD16XX_420] = {
        .name = "SSD16xx_420",
        .width = 400, .height = 300,
        .color_mode = EPD_COLOR_BW, .bits_per_pixel = 1,
        .caps = EPD_CAP_PARTIAL | EPD_CAP_FAST,
        .ctrl = EPD_CTRL_SSD16XX,
        .init_data = NULL,
    },
};

/*=============================================================================
 * Registry Lookup Functions
 *============================================================================*/

const epd_panel_desc_t* epd_get_panel_desc(epd_panel_type_t type)
{
    if (type >= EPD_PANEL_COUNT) {
        return NULL;
    }
    // Check if panel entry is valid (has a name)
    if (panel_registry[type].name == NULL) {
        return NULL;
    }
    return &panel_registry[type];
}

const epd_controller_ops_t* epd_get_controller_ops(epd_controller_type_t ctrl)
{
    if (ctrl >= EPD_CTRL_COUNT) {
        return NULL;
    }
    return &controller_ops[ctrl];
}
