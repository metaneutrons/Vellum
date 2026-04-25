idf_component_register(
    SRCS "vellum_serial.c"
    INCLUDE_DIRS "include"
    REQUIRES console nvs_manager wifi_manager esp_driver_uart
)
