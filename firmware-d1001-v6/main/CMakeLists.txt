idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_wifi esp_http_client nvs_flash esp_netif esp_lcd esp_timer d1001_board lcd_jd9365
)
