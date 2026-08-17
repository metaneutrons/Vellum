idf_component_register(
    SRCS "security_posture.c"
    INCLUDE_DIRS "include"
    REQUIRES bootloader_support esp_partition esp_system mbedtls spi_flash
)
