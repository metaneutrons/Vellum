# Display component: one shared screen layer (vellum_display.c) plus exactly
# one hardware backend selected by target:
#   - panel_lcd.c    (ESP32-P4, MIPI-DSI JD9365)
#   - panel_epaper.c (ESP32-S3, UC8179 / IT8951)
# The backend provides vellum_panel(); the shared layer draws all screens
# through that vtable. Each backend pulls in only its own (chip-specific,
# registry) drivers.
# status_layout.c is deliberately LVGL-free so firmware/host_test compiles this
# exact file (see test_status_layout.c) rather than a mirrored copy.
set(SRCS "vellum_display.c" "status_layout.c" "display_cache.c")

if("${IDF_TARGET}" STREQUAL "esp32p4")
    list(APPEND SRCS "panel_lcd.c" "logos/vellum_logo_color_360px.c")
    set(BACKEND_REQUIRES d1001_board lcd_jd9365 esp_lcd esp_mm
        espressif__esp_jpeg espressif__esp_lvgl_adapter)
else()
    list(APPEND SRCS "panel_epaper.c")
    if(CONFIG_VELLUM_PANEL_E1003)
        # Only this model gets the large fonts: 1404px short side needs glyphs
        # past LVGL's bundled 48px ceiling. ~244 KB, which the 480px panels would
        # otherwise pay for sizes they never select. See assets/render-fonts.sh.
        list(APPEND SRCS "logos/vellum_logo_16grey_600px.c"
                         "fonts/vellum_font_montserrat_64.c"
                         "fonts/vellum_font_montserrat_96.c")
    elseif(CONFIG_VELLUM_PANEL_GDEP073E01)
        list(APPEND SRCS "logos/vellum_logo_spectra_216px.c")
    else()
        list(APPEND SRCS "logos/vellum_logo_mono_216px.c")
    endif()
    set(BACKEND_REQUIRES epaper_uc8179 epaper_it8951 tuanpmt__esp_epaper)
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "include"
    PRIV_REQUIRES
        esp_driver_gpio esp_app_format esp_timer freertos esp_psram lvgl__lvgl
        nvs_manager espressif__qrcode
        ${BACKEND_REQUIRES}
)

# lv_font_conv emits `#include "lvgl/lvgl.h"` unless this is defined, and the
# managed component's directory is lvgl__lvgl, so that path does not resolve.
# (png2lvgl's output guards itself with __has_include and does not need this.)
target_compile_definitions(${COMPONENT_LIB} PRIVATE LV_LVGL_H_INCLUDE_SIMPLE)
