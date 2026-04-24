idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        nvs_manager
        wifi_manager
        http_client
        vellum_display
        buttons
        sleep_manager
        cJSON
        mbedtls
)
