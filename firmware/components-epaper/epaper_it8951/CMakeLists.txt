idf_component_register(
    SRCS "epaper_it8951.c"
    INCLUDE_DIRS "include"
    REQUIRES
        esp_driver_spi
        esp_driver_gpio
        esp_timer
)
