set(REQUIRES esp_driver_gpio nvs_manager esp_app_format)
set(SRCS "vellum_display.c")

if("${IDF_TARGET}" STREQUAL "esp32p4")
    list(APPEND REQUIRES d1001_board lcd_jd9365 esp_lcd espressif__esp_jpeg)
    list(APPEND SRCS "logos/vellum_logo_color_300px.c")
else()
    list(APPEND REQUIRES epaper_uc8179 epaper_it8951)
    if(CONFIG_VELLUM_PANEL_E1003)
        list(APPEND SRCS "logos/vellum_logo_16grey_600px.c")
    else()
        list(APPEND SRCS "logos/vellum_logo_mono_300px.c")
    endif()
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "include"
    REQUIRES ${REQUIRES}
)
