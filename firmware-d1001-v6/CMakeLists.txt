cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

set(EXTRA_COMPONENT_DIRS
    ${CMAKE_CURRENT_LIST_DIR}/../firmware/components/d1001_board
    ${CMAKE_CURRENT_LIST_DIR}/../firmware/components/lcd_jd9365
    ${CMAKE_CURRENT_LIST_DIR}/../firmware/components/esp_lcd_jd9365_8
    ${CMAKE_CURRENT_LIST_DIR}/../firmware/components/esp_io_expander_pca9535
)

project(vellum-d1001 VERSION 1.0.0)
