set(SRCS "vellum_display.c")

if(CONFIG_VELLUM_DRIVER_E1001)
    list(APPEND SRCS "drivers/driver_e1001.c")
elseif(CONFIG_VELLUM_DRIVER_E1002)
    list(APPEND SRCS "drivers/driver_e1002.c")
else()
    list(APPEND SRCS "drivers/driver_stub.c")
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "include"
    REQUIRES driver
)
