# Display component: one shared screen layer (vellum_display.c) plus exactly
# one hardware backend selected by target:
#   - panel_lcd.c    (ESP32-P4, MIPI-DSI JD9365)
#   - panel_epaper.c (ESP32-S3, UC8179 / IT8951)
# The backend provides vellum_panel(); the shared layer draws all screens
# through that vtable. Each backend pulls in only its own (chip-specific,
# registry) drivers.
set(SRCS "vellum_display.c")

if("${IDF_TARGET}" STREQUAL "esp32p4")
    list(APPEND SRCS "panel_lcd.c")
    set(BACKEND_REQUIRES d1001_board lcd_jd9365 esp_lcd esp_mm espressif__esp_jpeg)
else()
    list(APPEND SRCS "panel_epaper.c")
    if(CONFIG_VELLUM_PANEL_E1003)
        list(APPEND SRCS "logos/vellum_logo_16grey_600px.c")
    else()
        list(APPEND SRCS "logos/vellum_logo_mono_300px.c")
    endif()
    set(BACKEND_REQUIRES epaper_uc8179 epaper_it8951 tuanpmt__esp_epaper)
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        esp_driver_gpio esp_app_format esp_timer freertos esp_psram lvgl__lvgl
        nvs_manager espressif__qrcode
        ${BACKEND_REQUIRES}
)
