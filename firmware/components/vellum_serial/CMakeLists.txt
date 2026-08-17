idf_component_register(
    SRCS "vellum_serial.c"
    INCLUDE_DIRS "include"
    REQUIRES board console nvs_manager wifi_manager http_client esp_driver_uart esp_driver_usb_serial_jtag mbedtls
)
