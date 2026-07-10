# Vellum Firmware — ESP-IDF Project
# Supports: ESP32-S3 (E-Paper) and ESP32-P4 (LCD)

cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_SOURCE_DIR}/components"
    "${CMAKE_CURRENT_SOURCE_DIR}/components-epaper"
    "${CMAKE_CURRENT_SOURCE_DIR}/components-lcd"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# Per-model app-descriptor project_name (anti-brick). All four models otherwise
# share "vellum-firmware", so a wrong-model image would still pass signature
# verification and could brick a device (e.g. an e1001 image flashed onto an
# e1003). The model is baked into project_name so the OTA client can detect a
# mismatch on the STAGED image before finishing.
#
# It MUST be passed in from the build (Makefile / CI) as -DVELLUM_MODEL=<model>:
# sdkconfig cannot be read here because ESP-IDF generates it *during* project(),
# so it does not yet exist when this runs. Fall back to "vellum-firmware" for a
# bare `idf.py build` so a fresh checkout still builds (with no model check).
if(DEFINED VELLUM_MODEL AND NOT VELLUM_MODEL STREQUAL "")
    project(vellum-${VELLUM_MODEL})
else()
    message(WARNING "VELLUM_MODEL not set — building generic 'vellum-firmware'; "
                    "the OTA cross-model check will be inactive. Build via the "
                    "Makefile or CI which pass -DVELLUM_MODEL.")
    project(vellum-firmware)
endif()
