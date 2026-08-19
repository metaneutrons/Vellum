idf_component_register(
    SRCS "vellum_log.c" "log_ring.c"
    INCLUDE_DIRS "include"
    REQUIRES
        esp_timer esp_system log
)
