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
        mbedtls
        esp_https_ota
        esp_adc
        esp_driver_ledc
        esp_driver_i2c
        esp_driver_gpio
        app_update
)
