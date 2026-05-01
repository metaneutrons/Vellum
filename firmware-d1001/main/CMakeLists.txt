idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_http_client
        esp_event
        nvs_flash
        esp_netif
        esp_timer
        vellum_lcd
)
