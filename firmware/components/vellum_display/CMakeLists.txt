if(CONFIG_VELLUM_DISPLAY_IS_LCD)
    set(SRCS "vellum_display_lcd.c" "logos/vellum_logo_color_300px.c")
else()
    set(SRCS "vellum_display.c")
    if(CONFIG_VELLUM_PANEL_E1003)
        list(APPEND SRCS "logos/vellum_logo_16grey_600px.c")
    else()
        list(APPEND SRCS "logos/vellum_logo_mono_300px.c")
    endif()
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        esp_driver_gpio esp_app_format freertos esp_psram lvgl__lvgl
        d1001_board lcd_jd9365 esp_lcd espressif__esp_jpeg
        epaper_uc8179 epaper_it8951 espressif__qrcode tuanpmt__esp_epaper
        nvs_manager
)
