set(REQUIRES esp_driver_gpio nvs_manager)

if("${IDF_TARGET}" STREQUAL "esp32p4")
    list(APPEND REQUIRES d1001_board lcd_jd9365 esp_lcd espressif__esp_jpeg)
else()
    list(APPEND REQUIRES epaper_uc8179 epaper_it8951)
endif()

idf_component_register(
    SRCS "vellum_display.c"
    INCLUDE_DIRS "include"
    REQUIRES ${REQUIRES}
)
