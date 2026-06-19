# The display component has two mutually-exclusive backends selected by target:
#   - LCD  (ESP32-P4, MIPI-DSI JD9365)  → vellum_display_lcd.c
#   - E-Paper (ESP32-S3, UC8179/IT8951) → vellum_display.c
# Each backend pulls in only its own drivers so the other target's (chip-
# specific, registry) drivers are never dragged into the build.
if("${IDF_TARGET}" STREQUAL "esp32p4")
    idf_component_register(
        SRCS "vellum_display_lcd.c"
        INCLUDE_DIRS "include"
        PRIV_REQUIRES
            esp_driver_gpio esp_app_format freertos esp_psram lvgl__lvgl
            d1001_board lcd_jd9365 esp_lcd espressif__esp_jpeg
            nvs_manager
    )
else()
    set(SRCS "vellum_display.c")
    if(CONFIG_VELLUM_PANEL_E1003)
        list(APPEND SRCS "logos/vellum_logo_16grey_600px.c")
    else()
        list(APPEND SRCS "logos/vellum_logo_mono_300px.c")
    endif()
    idf_component_register(
        SRCS ${SRCS}
        INCLUDE_DIRS "include"
        PRIV_REQUIRES
            esp_driver_gpio esp_app_format freertos esp_psram lvgl__lvgl
            epaper_uc8179 epaper_it8951 espressif__qrcode tuanpmt__esp_epaper
            nvs_manager
    )
endif()
