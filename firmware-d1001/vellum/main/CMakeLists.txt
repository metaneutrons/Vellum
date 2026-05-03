idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_wifi esp_http_client nvs_flash esp_netif esp_lcd json esp_timer esp32_p4_re_terminal_d1001
)
