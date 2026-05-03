idf_component_register(
    SRCS "d1001_board.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES driver esp_adc esp_io_expander_pca9535
)
