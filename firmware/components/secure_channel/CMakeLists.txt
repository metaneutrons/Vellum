idf_component_register(
    SRCS "secure_channel.c"
    INCLUDE_DIRS "include"
    REQUIRES nvs_manager mbedtls
)
