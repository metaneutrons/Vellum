set(board_requires esp_adc esp_driver_ledc esp_driver_gpio)
if("${IDF_TARGET}" STREQUAL "esp32p4")
    # D1001 (ESP32-P4): the board_* battery/USB accessors delegate to the P4
    # board support (d1001_board), which owns the P4 ADC. No cycle — d1001_board
    # does not require board.
    list(APPEND board_requires d1001_board)
endif()

idf_component_register(
    SRCS "board.c"
    INCLUDE_DIRS "include"
    REQUIRES ${board_requires}
)
