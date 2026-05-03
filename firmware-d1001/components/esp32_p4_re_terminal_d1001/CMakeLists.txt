set(SRCS "")
list(APPEND SRCS
    "src/lsm6ds3tr-c_reg.c"
    "src/bsp_lsm6ds3.c"
    "src/bsp_pcf8563.c"
    "src/esp32_p4_re_terminal_d1001.c" 
)

foreach(SRC_DIR IN LISTS SRC_DIRS)
    file(GLOB_RECURSE SRC ${SRC_DIR}/*.c)
    list(APPEND SRCS ${SRC})
endforeach()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "priv_include"
    REQUIRES driver
    PRIV_REQUIRES esp_adc esp_lcd usb spiffs fatfs esp_timer
)
