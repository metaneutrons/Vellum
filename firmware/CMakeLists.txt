# Vellum Firmware — ESP-IDF Project
# Supports: ESP32-S3 (E-Paper) and ESP32-P4 (LCD)

cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_SOURCE_DIR}/components"
    "${CMAKE_CURRENT_SOURCE_DIR}/components-p4"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(vellum-firmware)
