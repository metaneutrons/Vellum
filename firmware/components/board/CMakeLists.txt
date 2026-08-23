set(board_requires esp_adc esp_driver_ledc esp_driver_gpio esp_driver_i2c
    esp_driver_usb_serial_jtag
    # esp_timer: led_indicator.c ticks its patterns from a periodic timer.
    # Not part of the implicit common requirements, despite being ubiquitous.
    esp_timer)
if("${IDF_TARGET}" STREQUAL "esp32p4")
    # D1001 (ESP32-P4): the board_* battery/USB accessors delegate to the P4
    # board support (d1001_board), which owns the P4 ADC. esp_io_expander is
    # d1001_board.h's transitive include, needed so board.c can include that
    # header. No cycle — d1001_board does not require board.
    # vellum_audio: the buzzer call plays a chime through the ES8311 speaker on
    # this model, because the LEDC channel below drives the LCD backlight.
    list(APPEND board_requires d1001_board esp_io_expander vellum_audio)
endif()

idf_component_register(
    SRCS "board.c" "led_indicator.c" "sy6974b_power.c"
    INCLUDE_DIRS "include"
    REQUIRES ${board_requires}
)
