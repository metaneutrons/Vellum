idf_component_register(
    SRCS "nvs_manager.c"
    INCLUDE_DIRS "include"
    REQUIRES nvs_flash mbedtls esp_hw_support
)
