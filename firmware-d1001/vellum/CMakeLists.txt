cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

set(EXTRA_COMPONENT_DIRS
    ${CMAKE_CURRENT_LIST_DIR}/../components/esp32_p4_re_terminal_d1001
    ${CMAKE_CURRENT_LIST_DIR}/../components/esp_lcd_jd9365_8
    ${CMAKE_CURRENT_LIST_DIR}/../components/esp_lcd_touch_gsl3670
    ${CMAKE_CURRENT_LIST_DIR}/../components/esp_io_expander_pca9535
    ${CMAKE_CURRENT_LIST_DIR}/../components/esp_cam_sensor
)

# Exclude components we don't need
set(EXCLUDE_COMPONENTS
    "iot_usbh_modem"
    "esp-brookesia"
    "bsp_extra"
)

project(vellum-d1001 VERSION 1.0.0)
