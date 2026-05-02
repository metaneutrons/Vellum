idf_component_register(
    SRCS "vellum_display.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_gpio nvs_manager epaper_uc8179 epaper_it8951
)
