idf_component_register(
    SRCS "board.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_adc esp_driver_ledc esp_driver_gpio
)
