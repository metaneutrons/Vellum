idf_component_register(
    SRCS "http_client.c" "transport_policy.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_client esp-tls nvs_manager mbedtls
)
