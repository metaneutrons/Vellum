idf_component_register(
    SRCS "d1001_board.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_driver_gpio esp_driver_i2c esp_driver_ledc
    PRIV_REQUIRES esp_adc esp_io_expander_pca9535
)
