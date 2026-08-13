# Audible feedback for models with a real speaker — D1001 only.
#
# The E-Series boards have no audio path at all (a PWM buzzer instead), and
# esp_codec_dev is fetched only for the P4 target, so building this component
# elsewhere would fail to resolve its dependencies. Registering with no sources
# keeps the component name resolvable for `REQUIRES` on every target.
if("${IDF_TARGET}" STREQUAL "esp32p4")
    idf_component_register(
        SRCS "vellum_audio.c" "chime_pcm.c"
        INCLUDE_DIRS "include"
        PRIV_REQUIRES
            esp_driver_i2s esp_driver_i2c freertos
            d1001_board esp_io_expander espressif__esp_codec_dev
    )
else()
    idf_component_register(INCLUDE_DIRS "include")
endif()
