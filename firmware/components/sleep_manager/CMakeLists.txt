idf_component_register(
    SRCS "sleep_manager.c" "render_backoff.c"
    INCLUDE_DIRS "include"
    REQUIRES board buttons esp_hw_support esp_driver_gpio driver
)
