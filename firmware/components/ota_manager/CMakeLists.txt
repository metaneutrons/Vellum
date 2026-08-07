idf_component_register(
    SRCS "ota_manager.c"
    INCLUDE_DIRS "include"
    REQUIRES
        http_client
        vellum_display
        board
        mbedtls
        esp_https_ota
        app_update
        esp_app_format
        esp-tls
        espressif__cjson
        espressif__libsodium
)
