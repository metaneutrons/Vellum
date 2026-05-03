idf_component_register(
    SRCS "lcd_jd9365.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_lcd
    PRIV_REQUIRES esp_lcd_jd9365_8
)
