idf_component_register(
    SRCS "vellum_lcd.c"
    INCLUDE_DIRS "include"
    REQUIRES
        esp_lcd
        esp_timer
        driver
        esp_mm
    PRIV_REQUIRES
        espressif__esp_jpeg
)
