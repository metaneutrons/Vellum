/*
 * SPDX-FileCopyrightText: 2024 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file
 * @brief ESP BSP: ESP32-P4 Function EV Board
 */

#pragma once

#include "sdkconfig.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/sdmmc_host.h"
#include "driver/i2s_std.h"
#include "driver/i2s_tdm.h"
#include "config.h"
#include "display.h"
#include "esp_codec_dev.h"
#include "sdkconfig.h"

#if (BSP_CONFIG_NO_GRAPHIC_LIB == 0)
#include "lvgl.h"
#include "esp_lvgl_port.h"
#endif // BSP_CONFIG_NO_GRAPHIC_LIB == 0

/**************************************************************************************************
 *  BSP Capabilities
 **************************************************************************************************/

#define BSP_CAPS_DISPLAY        1
#define BSP_CAPS_TOUCH          1
#define BSP_CAPS_BUTTONS        1
#define BSP_CAPS_AUDIO          1
#define BSP_CAPS_AUDIO_SPEAKER  1
#define BSP_CAPS_AUDIO_MIC      1
#define BSP_CAPS_SDCARD         1
#define BSP_CAPS_IMU            1

/**************************************************************************************************
 *  ESP-BOX pinout
 **************************************************************************************************/
/* Power */
#define BSP_PWR_HOLD                (1ULL << 8) // EXP_PIN_NUM_8

/* I2C */
#define BSP_I2C_0_SCL               (GPIO_NUM_38) // touch/cam/light
#define BSP_I2C_0_SDA               (GPIO_NUM_37)

#define BSP_I2C_1_SCL               (GPIO_NUM_21) // adc/codec/6dof/rtc/io_exp
#define BSP_I2C_1_SDA               (GPIO_NUM_20)

/* Audio */
#define BSP_ADC_I2S_MCLK            (GPIO_NUM_29)
#define BSP_ADC_I2S_SCLK            (GPIO_NUM_28)
#define BSP_ADC_I2S_LRLK            (GPIO_NUM_27)
#define BSP_ADC_I2S_SDIN            (GPIO_NUM_26)
#define BSP_ADC_I2S_SDOUT           (GPIO_NUM_NC)

#define BSP_DAC_I2S_MCLK            (GPIO_NUM_33)
#define BSP_DAC_I2S_SCLK            (GPIO_NUM_32)
#define BSP_DAC_I2S_LRLK            (GPIO_NUM_31)
#define BSP_DAC_I2S_SDIN            (GPIO_NUM_NC)
#define BSP_DAC_I2S_SDOUT           (GPIO_NUM_30)

#define BSP_POWER_AMP_EN            (1ULL << 11) // EXP_PIN_NUM_11

/* Display */
#define BSP_LCD_BACKLIGHT           (GPIO_NUM_14)
#define BSP_LCD_TOUCH_INT           (GPIO_NUM_16)

#define BPS_LCD_PWR_EN              (1ULL << 0) // EXP_PIN_NUM_0
#define BSP_LCD_BACKLIGHT_EN        (1ULL << 7) // EXP_PIN_NUM_7
#define BSP_LCD_RST                 (1ULL << 2) // EXP_PIN_NUM_2
#define BSP_LCD_TOUCH_RST           (1ULL << 12) // EXP_PIN_NUM_12

/* Battery */
#define BSP_BAT_READ                (GPIO_NUM_18) // ADC1_CHANNEL_2
#define BSP_BAT_CHARGE_STATE        (GPIO_NUM_15)
#define BSP_BAT_VSYS_PG             (GPIO_NUM_4)
#define BSP_BAT_CHARGE_EN           (1ULL << 10) // EXP_PIN_NUM_10
#define BSP_BAT_READ_EN             (1ULL << 6) // EXP_PIN_NUM_6

/* USB */
#define BSP_USB_INSERT_DET          (GPIO_NUM_17) // ADC1_CHANNEL_1

/* Button */
#define BSP_BUTTON_IN               (GPIO_NUM_3)

/* LED */
#define BSP_LED_R                   (GPIO_NUM_22)
#define BSP_LED_G                   (GPIO_NUM_36)
#define BSP_LED_B                   (GPIO_NUM_23)

/* RTC */
#define BSP_RTC_INT                 (GPIO_NUM_34)

/* 6DF */
#define BSP_6DF_INT                 (GPIO_NUM_19)

/* uSD card */
#define BSP_SD_D0                   (GPIO_NUM_39)
#define BSP_SD_D1                   (GPIO_NUM_40)
#define BSP_SD_D2                   (GPIO_NUM_41)
#define BSP_SD_D3                   (GPIO_NUM_42)
#define BSP_SD_CLK                  (GPIO_NUM_43)
#define BSP_SD_CMD                  (GPIO_NUM_44)
#define BSP_SD_PWR_EN               (GPIO_NUM_46)
#define BSP_SD_DETECT               (GPIO_NUM_45)

/* Wifi */
#define BSP_WIFI_SDIO_CMD           (GPIO_NUM_6)
#define BSP_WIFI_SDIO_D0            (GPIO_NUM_7)
#define BSP_WIFI_SDIO_D1            (GPIO_NUM_8)
#define BSP_WIFI_SDIO_D2            (GPIO_NUM_9)
#define BSP_WIFI_SDIO_D3            (GPIO_NUM_10)
#define BSP_WIFI_SDIO_CLK           (GPIO_NUM_11)
#define BSP_WIFI_CHIP_PU            (GPIO_NUM_13)
#define BSP_WIFI_TXD0               (GPIO_NUM_48)
#define BSP_WIFI_RXD0               (GPIO_NUM_47)
#define BSP_WIFI_BOOT               (GPIO_NUM_12)

/* Camera */
#define BSP_CAM_PWDN                (1ULL << 3) // EXP_PIN_NUM_3
#define BSP_CAM_EN                  (1ULL << 1) // EXP_PIN_NUM_1
#define BSP_CAM_RST                 (1ULL << 9) // EXP_PIN_NUM_9

/* LTE */
// pcie_usb connect to p4_usb_hs
#define BSP_LTE_WAKE_HOST           (GPIO_NUM_2)
#define BSP_LTE_AIRPLANE_MODE       (1ULL << 13) // EXP_PIN_NUM_13
#define BSP_LTE_RESET               (1ULL << 14) // EXP_PIN_NUM_14
#define BSP_LTE_PWR_EN              (1ULL << 15) // EXP_PIN_NUM_15
#define BSP_LTE_DTR                 (1ULL << 4) // EXP_PIN_NUM_4

/* LoRa */
#define BSP_LORA_SPI_CS             (GPIO_NUM_5)
#define BSP_LORA_SPI_MISO           (GPIO_NUM_49)
#define BSP_LORA_SPI_MOSI           (GPIO_NUM_50)
#define BSP_LORA_SPI_SCK            (GPIO_NUM_51)
#define BSP_LORA_BUSY               (GPIO_NUM_52)
#define BSP_LORA_INT                (GPIO_NUM_53)
#define BSP_LORA_RESET              (GPIO_NUM_54)

#ifdef __cplusplus
extern "C" {
#endif

/**************************************************************************************************
 *
 * I2C_0 interface
 *
 * There are multiple devices connected to I2C peripheral:
 *  - LCD Touch controller
 *  - Camera controller
 *  - Light sensor
 **************************************************************************************************/

/**
 * @brief Init I2C_0 driver
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   I2C parameter error
 *      - ESP_FAIL              I2C driver installation error
 *
 */
esp_err_t bsp_i2c_0_init(void);

/**
 * @brief Deinit I2C_0 driver and free its resources
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   I2C parameter error
 *
 */
esp_err_t bsp_i2c_0_deinit(void);

/**
 * @brief Get I2C_0 driver handle
 *
 * @return
 *      - I2C handle
 *
 */
i2c_master_bus_handle_t bsp_i2c_0_get_handle(void);

/**************************************************************************************************
 *
 * I2C_1 interface
 *
 * There are multiple devices connected to I2C peripheral:
 *  - ADC ES7210
 *  - DAC ES8311
 *  - RTC PCF8563
 *  - IO expander PCA9535
 **************************************************************************************************/
/**
 * @brief Init I2C_1 driver
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   I2C parameter error
 *      - ESP_FAIL              I2C driver installation error
 *
 */
esp_err_t bsp_i2c_1_init(void);

/**
 * @brief Deinit I2C_1 driver and free its resources
 *
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_INVALID_ARG   I2C parameter error
 *
 */
esp_err_t bsp_i2c_1_deinit(void);

/**
 * @brief Get I2C_1 driver handle
 *
 * @return
 *      - I2C handle
 *
 */
i2c_master_bus_handle_t bsp_i2c_1_get_handle(void);

/**************************************************************************************************
 *
 * I2S audio interface
 *
 * There are two devices connected to the I2S peripheral:
 *  - Codec ES8311 for output(playback) and input(recording) path
 *
 * For speaker initialization use bsp_audio_codec_speaker_init() which is inside initialize I2S with bsp_audio_init().
 * For microphone initialization use bsp_audio_codec_microphone_init() which is inside initialize I2S with bsp_audio_init().
 * After speaker or microphone initialization, use functions from esp_codec_dev for play/record audio.
 * Example audio play:
 * \code{.c}
 * esp_codec_dev_set_out_vol(spk_codec_dev, DEFAULT_VOLUME);
 * esp_codec_dev_open(spk_codec_dev, &fs);
 * esp_codec_dev_write(spk_codec_dev, wav_bytes, bytes_read_from_spiffs);
 * esp_codec_dev_close(spk_codec_dev);
 * \endcode
 **************************************************************************************************/

/**
 * @brief Init audio
 *
 * @note There is no deinit audio function. Users can free audio resources by calling i2s_del_channel()
 * @warning The type of i2s_config param is depending on IDF version.
 * @param[in]  i2s_adc_config I2S ADC configuration. Pass NULL to use default values (Mono, duplex, 16bit, 22050 Hz)
 * @param[in]  i2s_dac_config I2S DAC configuration. Pass NULL to use default values (Mono, duplex, 16bit, 22050 Hz)
 * @return
 *      - ESP_OK                On success
 *      - ESP_ERR_NOT_SUPPORTED The communication mode is not supported on the current chip
 *      - ESP_ERR_INVALID_ARG   NULL pointer or invalid configuration
 *      - ESP_ERR_NOT_FOUND     No available I2S channel found
 *      - ESP_ERR_NO_MEM        No memory for storing the channel information
 *      - ESP_ERR_INVALID_STATE This channel has not initialized or already started
 */
esp_err_t bsp_audio_init(const i2s_std_config_t *i2s_adc_config, const i2s_std_config_t *i2s_dac_config);

/**
 * @brief Initialize speaker codec device
 *
 * @return Pointer to codec device handle or NULL when error occurred
 */
esp_codec_dev_handle_t bsp_audio_codec_speaker_init(void);

/**
 * @brief Initialize microphone codec device
 *
 * @return Pointer to codec device handle or NULL when error occurred
 */
esp_codec_dev_handle_t bsp_audio_codec_microphone_init(void);

/**************************************************************************************************
 *
 * SPIFFS
 *
 * After mounting the SPIFFS, it can be accessed with stdio functions ie.:
 * \code{.c}
 * FILE* f = fopen(BSP_SPIFFS_MOUNT_POINT"/hello.txt", "w");
 * fprintf(f, "Hello World!\n");
 * fclose(f);
 * \endcode
 **************************************************************************************************/
#define BSP_SPIFFS_MOUNT_POINT      CONFIG_BSP_SPIFFS_MOUNT_POINT

/**
 * @brief Mount SPIFFS to virtual file system
 *
 * @return
 *      - ESP_OK on success
 *      - ESP_ERR_INVALID_STATE if esp_vfs_spiffs_register was already called
 *      - ESP_ERR_NO_MEM if memory can not be allocated
 *      - ESP_FAIL if partition can not be mounted
 *      - other error codes
 */
esp_err_t bsp_spiffs_mount(void);

/**
 * @brief Unmount SPIFFS from virtual file system
 *
 * @return
 *      - ESP_OK on success
 *      - ESP_ERR_NOT_FOUND if the partition table does not contain SPIFFS partition with given label
 *      - ESP_ERR_INVALID_STATE if esp_vfs_spiffs_unregister was already called
 *      - ESP_ERR_NO_MEM if memory can not be allocated
 *      - ESP_FAIL if partition can not be mounted
 *      - other error codes
 */
esp_err_t bsp_spiffs_unmount(void);

/**************************************************************************************************
 *
 * uSD card
 *
 * After mounting the uSD card, it can be accessed with stdio functions ie.:
 * \code{.c}
 * FILE* f = fopen(BSP_MOUNT_POINT"/hello.txt", "w");
 * fprintf(f, "Hello %s!\n", bsp_sdcard->cid.name);
 * fclose(f);
 * \endcode
 **************************************************************************************************/
#define BSP_SD_MOUNT_POINT      CONFIG_BSP_SD_MOUNT_POINT
extern sdmmc_card_t *bsp_sdcard;

/**
 * @brief Mount microSD card to virtual file system
 *
 * @return
 *      - ESP_OK on success
 *      - ESP_ERR_INVALID_STATE if esp_vfs_fat_sdmmc_mount was already called
 *      - ESP_ERR_NO_MEM if memory cannot be allocated
 *      - ESP_FAIL if partition cannot be mounted
 *      - other error codes from SDMMC or SPI drivers, SDMMC protocol, or FATFS drivers
 */
esp_err_t bsp_sdcard_mount(void);

/**
 * @brief Unmount microSD card from virtual file system
 *
 * @return
 *      - ESP_OK on success
 *      - ESP_ERR_NOT_FOUND if the partition table does not contain FATFS partition with given label
 *      - ESP_ERR_INVALID_STATE if esp_vfs_fat_spiflash_mount was already called
 *      - ESP_ERR_NO_MEM if memory can not be allocated
 *      - ESP_FAIL if partition can not be mounted
 *      - other error codes from wear levelling library, SPI flash driver, or FATFS drivers
 */
esp_err_t bsp_sdcard_unmount(void);

/**************************************************************************************************
 *
 * LCD interface
 *
 * ESP-BOX is shipped with 2.4inch ST7789 display controller.
 * It features 16-bit colors, 320x240 resolution and capacitive touch controller.
 *
 * LVGL is used as graphics library. LVGL is NOT thread safe, therefore the user must take LVGL mutex
 * by calling bsp_display_lock() before calling and LVGL API (lv_...) and then give the mutex with
 * bsp_display_unlock().
 *
 * Display's backlight must be enabled explicitly by calling bsp_display_backlight_on()
 **************************************************************************************************/
#if (BSP_CONFIG_NO_GRAPHIC_LIB == 0)

#define BSP_LCD_DRAW_BUFF_SIZE     (BSP_LCD_H_RES * 50) // Frame buffer size in pixels
#define BSP_LCD_DRAW_BUFF_DOUBLE   (0)

/**
 * @brief BSP display configuration structure
 *
 */
typedef struct {
    lvgl_port_cfg_t lvgl_port_cfg;  /*!< LVGL port configuration */
    uint32_t        buffer_size;    /*!< Size of the buffer for the screen in pixels */
    bool            double_buffer;  /*!< True, if should be allocated two buffers */
    struct {
        unsigned int buff_dma: 1;    /*!< Allocated LVGL buffer will be DMA capable */
        unsigned int buff_spiram: 1; /*!< Allocated LVGL buffer will be in PSRAM */
        unsigned int sw_rotate: 1;   /*!< Use software rotation (slower), The feature is unavailable under avoid-tear mode */
    } flags;
} bsp_display_cfg_t;

/**
 * @brief Initialize display
 *
 * This function initializes SPI, display controller and starts LVGL handling task.
 * LCD backlight must be enabled separately by calling bsp_display_brightness_set()
 *
 * @return Pointer to LVGL display or NULL when error occured
 */
lv_display_t *bsp_display_start(void);

/**
 * @brief Initialize display
 *
 * This function initializes SPI, display controller and starts LVGL handling task.
 * LCD backlight must be enabled separately by calling bsp_display_brightness_set()
 *
 * @param cfg display configuration
 *
 * @return Pointer to LVGL display or NULL when error occured
 */
lv_display_t *bsp_display_start_with_config(const bsp_display_cfg_t *cfg);

/**
 * @brief Get pointer to input device (touch, buttons, ...)
 *
 * @note The LVGL input device is initialized in bsp_display_start() function.
 *
 * @return Pointer to LVGL input device or NULL when not initialized
 */
lv_indev_t *bsp_display_get_input_dev(void);

/**
 * @brief Take LVGL mutex
 *
 * @param timeout_ms Timeout in [ms]. 0 will block indefinitely.
 * @return true  Mutex was taken
 * @return false Mutex was NOT taken
 */
bool bsp_display_lock(uint32_t timeout_ms);

/**
 * @brief Give LVGL mutex
 *
 */
void bsp_display_unlock(void);

/**
 * @brief Rotate screen
 *
 * Display must be already initialized by calling bsp_display_start()
 *
 * @param[in] disp Pointer to LVGL display
 * @param[in] rotation Angle of the display rotation
 */
void bsp_display_rotate(lv_display_t *disp, lv_disp_rotation_t rotation);
#endif // BSP_CONFIG_NO_GRAPHIC_LIB == 0

/**
 * @brief Read battery voltage
 *
 * @return voltage in mV
 */
int bsp_battery_voltage_read(void);

/**
 * @brief Read battery percent
 *
 * @return battery percent
 */
int bsp_battery_percent_read(void);

/**
 * @brief Read usb voltage
 *
 * @return voltage in mV
 */
int bsp_usb_voltage_read(void);

/**
 * @brief Read battery charge status
 *
 * @return 
 *     - True       Charging
 *     - False      Not charge
 */
bool bsp_battery_charge_status_read(void);

/**
 * @brief start battery charge manage
 *
 * @return 
 *     - ESP_OK                 On success
 *     - ESP_ERR_INVALID_ARG    Parameter error
 *     - ESP_ERR_NO_MEM         Memory cannot be allocated
 */
esp_err_t bsp_battery_manage_start(void);

/**
 * @brief 
 * 
 * @return
 */
esp_err_t bsp_sd_card_manage_start(bool cmd);

/**
 * @brief 
 * 
 * @return
 */
bool bsp_sd_card_get_mount_state(void);

/**
 * @brief 
 * 
 * @return
 */
bool bsp_backlight_get_enable_state(void);

/**
 * @brief 
 * 
 * @return
 */
esp_err_t bsp_rgb_led_duty_set(uint8_t rgb, int percent);

/**
 * @brief 
 *
 * @param[in] cmd 
 */
void bsp_led_red_set(bool cmd);

/**
 * @brief 
 *
 * @param[in] cmd 
 */
void bsp_led_green_set(bool cmd);

/**
 * @brief 
 *
 * @param[in] cmd 
 */
void bsp_led_blue_set(bool cmd);

/**
 * @brief 
 * 
 * @return
 */
void bsp_power_off(void);

/**
 * @brief Board power up init
 *
 * Hold the power pin in first
 *
 * @return
 *     - ESP_OK              On success
 *     - ESP_ERR_INVALID_ARG Parameter error
 */
esp_err_t bsp_power_init(void);

#ifdef __cplusplus
}
#endif
