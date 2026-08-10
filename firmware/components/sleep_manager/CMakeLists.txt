idf_component_register(
    SRCS "sleep_manager.c"
    INCLUDE_DIRS "include"
    REQUIRES board esp_hw_support esp_driver_gpio driver
)
