if(NOT "${IDF_TARGET}" STREQUAL "esp32p4")
    idf_component_register()
    return()
endif()

idf_component_register(SRCS "esp_lcd_jd9365_8.c" INCLUDE_DIRS "include" PRIV_REQUIRES "driver" REQUIRES "esp_lcd")
