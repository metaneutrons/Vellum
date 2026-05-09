idf_component_register(
    SRCS "sleep_manager.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_hw_support esp_driver_gpio driver
)
