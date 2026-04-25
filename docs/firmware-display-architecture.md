# Vellum Firmware Display Architecture

## Overview

The display layer has two distinct rendering modes:

1. **Local Mode (LVGL)** — Device renders UI locally for system screens
2. **Server Mode (Raw Buffer)** — Server sends pre-rendered pixel buffer, device writes it directly to the display

Both modes share the same underlying display driver (`esp_epaper` component).

---

## Component Stack

```
┌─────────────────────────────────────────────────┐
│                  Application                     │
│                                                  │
│  ┌──────────────┐       ┌─────────────────────┐ │
│  │  Local Mode   │       │   Server Mode       │ │
│  │  (LVGL 9)     │       │   (Raw Buffer)      │ │
│  │               │       │                     │ │
│  │  Boot Logo    │       │  HTTP GET /render    │ │
│  │  WiFi Setup   │       │  → pixel buffer     │ │
│  │  QR Code      │       │  → epd_update()     │ │
│  │  OTA Progress │       │                     │ │
│  │  Error Screen │       │                     │ │
│  │  Status Info  │       │                     │ │
│  └──────┬───────┘       └──────────┬──────────┘ │
│         │                          │             │
│         ▼                          ▼             │
│  ┌─────────────────────────────────────────────┐ │
│  │           vellum_display (abstraction)       │ │
│  │                                              │ │
│  │  display_init()                              │ │
│  │  display_update_lvgl()   — flush LVGL buffer │ │
│  │  display_update_raw()    — write server buf  │ │
│  │  display_sleep()                             │ │
│  │  display_get_info()      — width, height,    │ │
│  │                            colors, model     │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                            │
│                     ▼                            │
│  ┌─────────────────────────────────────────────┐ │
│  │        esp_epaper (ESP Component)            │ │
│  │        tuanpmt/esp_epaper ^2.0.0             │ │
│  │                                              │ │
│  │  Supported panels:                           │ │
│  │  - GDEY075T7   (E1001, 7.5" BW, 800x480)   │ │
│  │  - GDEP073E01  (E1002, 7.3" 6-Color)        │ │
│  │  - TBD         (E1003, 10.3" Mono)           │ │
│  │                                              │ │
│  │  Features:                                   │ │
│  │  - Correct init sequences per panel          │ │
│  │  - SPI communication                         │ │
│  │  - Busy wait handling                        │ │
│  │  - Power management (sleep/wake)             │ │
│  │  - LVGL 9 display driver integration         │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## Local Mode Screens (LVGL)

These screens are rendered on-device when the server is not available or during system operations.

### 1. Boot Screen
- **When**: Power on, wake from deep sleep
- **Content**: Vellum logo centered, firmware version, model info
- **Duration**: Shown until WiFi connects or captive portal starts
- **Refresh**: Full refresh (first draw after sleep)

### 2. WiFi Setup (Captive Portal)
- **When**: No WiFi credentials stored, or connection fails
- **Content**: 
  - QR code linking to captive portal URL (192.168.4.1)
  - SSID: "Vellum-XXXX" (last 4 of MAC)
  - Instructions text: "Scan to configure WiFi"
- **Refresh**: Full refresh once

### 3. Connecting Screen
- **When**: WiFi credentials exist, attempting connection
- **Content**: "Connecting to WiFi..." with SSID name
- **Refresh**: Partial refresh (if supported by panel)

### 4. Server Discovery
- **When**: WiFi connected, searching for Vellum server via mDNS
- **Content**: "Searching for server..." 
- **Refresh**: Partial refresh

### 5. OTA Update Screen
- **When**: Firmware update in progress
- **Content**: 
  - Vellum logo (smaller, top)
  - "Updating firmware..."
  - Progress bar (percentage)
  - "Do not power off"
- **Refresh**: Partial refresh for progress updates

### 6. Error Screen
- **When**: Unrecoverable error (no server found after timeout, auth failed, etc.)
- **Content**: Error icon + message + suggested action
- **Refresh**: Full refresh

### 7. Low Battery Screen
- **When**: Battery critically low
- **Content**: Battery icon + "Low Battery" + "Please charge"
- **Refresh**: Full refresh, then deep sleep

---

## Server Mode (Raw Buffer)

### Flow
```
Server                          Device
  │                               │
  │  GET /render?mac=XX           │
  │◄──────────────────────────────│
  │                               │
  │  Render content (Canvas API)  │
  │  Quantize to panel palette    │
  │  Return pixel buffer          │
  │                               │
  │  Content-Type: application/   │
  │  octet-stream                 │
  │  X-Sleep-Seconds: 300         │
  │──────────────────────────────►│
  │                               │
  │                    epd_update(buffer)
  │                    epd_sleep()
  │                    deep_sleep(300s)
  │                               │
```

### Pixel Buffer Format

The server sends a raw byte array. Format depends on the panel:

| Panel | Color Mode | Bits/Pixel | Buffer Size | Format |
|-------|-----------|------------|-------------|--------|
| E1001 | BW | 1 bpp | 48,000 bytes | 1 bit per pixel, MSB first |
| E1002 | 6-Color | 4 bpp | 192,000 bytes | 4 bits per pixel (2 pixels/byte) |
| E1003 | Mono | 1 bpp | ~160,000 bytes | 1 bit per pixel, MSB first |

### E1002 Color Encoding (4-bit native)

| Value | Color |
|-------|-------|
| 0x00 | Black |
| 0x01 | White |
| 0x02 | Yellow |
| 0x03 | Red |
| 0x04 | Orange |
| 0x05 | Blue |
| 0x06 | Green |
| 0x07 | White (clean) |

Two pixels per byte: `[pixel0_high_nibble | pixel1_low_nibble]`

### Device-Side Processing

For server-rendered content, the device does **zero processing**:
1. Receive buffer via HTTP
2. Validate size matches expected (width × height × bpp / 8)
3. Write directly to display via `epd_update(buffer, EPD_UPDATE_FULL)`
4. No dithering, no color conversion, no scaling — server handles everything

---

## esp_epaper Integration

### Dependencies

```yaml
# firmware/main/idf_component.yml
dependencies:
  tuanpmt/esp_epaper: "^2.0.0"
  espressif/cjson: ">=1.7.15"
  espressif/mdns: ">=1.0.0"
```

### Configuration (Kconfig)

```
choice VELLUM_DISPLAY_PANEL
    prompt "Display panel"
    default VELLUM_PANEL_GDEP073E01

    config VELLUM_PANEL_GDEY075T7
        bool "E1001 — GDEY075T7 (7.5\" BW, 800×480)"

    config VELLUM_PANEL_GDEP073E01
        bool "E1002 — GDEP073E01 (7.3\" 6-Color, 800×480)"

    config VELLUM_PANEL_E1003
        bool "E1003 — TBD (10.3\" Mono)"
endchoice
```

### Pin Configuration

All reTerminal E-Series models share the same SPI pinout:

| Signal | GPIO | Notes |
|--------|------|-------|
| SCK | 7 | SPI Clock |
| MOSI | 9 | SPI Data |
| CS | 10 | Chip Select (active low) |
| DC | 11 | Data/Command |
| RST | 12 | Reset (active low) |
| BUSY | 13 | Busy signal (active low for GDEP073E01) |
| SD_CS | 14 | SD Card CS (keep HIGH to avoid bus conflict) |
| SD_EN | 16 | SD Card power enable |

### Initialization

```c
#include "epaper.h"
#include "epaper_lvgl.h"

static epd_handle_t s_epd;
static lv_display_t *s_lvgl_disp;

void display_init(void)
{
    // Deselect SD card to avoid SPI bus conflict
    gpio_set_direction(GPIO_NUM_14, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_14, 1);
    gpio_set_direction(GPIO_NUM_16, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_16, 0);

    // Configure for reTerminal E1002
    epd_config_t cfg = {
        .pins = {
            .busy = GPIO_NUM_13,
            .rst  = GPIO_NUM_12,
            .dc   = GPIO_NUM_11,
            .cs   = GPIO_NUM_10,
            .sck  = GPIO_NUM_7,
            .mosi = GPIO_NUM_9,
        },
        .spi = {
            .host = SPI2_HOST,
            .speed_hz = 2000000,  // 2 MHz safe for e-paper
        },
        .panel = {
            .type = EPD_PANEL_GDEP073E01,
        },
    };

    ESP_ERROR_CHECK(epd_init(&cfg, &s_epd));

    // Initialize LVGL for local screens
    lv_init();
    epd_lvgl_config_t lvgl_cfg = EPD_LVGL_CONFIG_DEFAULT();
    lvgl_cfg.epd = s_epd;
    lvgl_cfg.update_mode = EPD_UPDATE_FULL;
    s_lvgl_disp = epd_lvgl_init(&lvgl_cfg);
}
```

---

## vellum_display API

The abstraction layer provides a clean interface for both modes:

```c
// Initialize display + LVGL
esp_err_t display_init(void);

// Get display info (reported to server in /hello)
typedef struct {
    const char *model;      // "e1001", "e1002", "e1003"
    uint16_t width;         // 800
    uint16_t height;        // 480
    uint8_t bpp;            // 1 or 4
    const char *color_mode; // "bw", "color", "mono"
} display_info_t;
esp_err_t display_get_info(display_info_t *info);

// Local mode: show LVGL screen
void display_show_boot(const char *version);
void display_show_wifi_setup(const char *ssid, const char *url);
void display_show_connecting(const char *ssid);
void display_show_ota_progress(uint8_t percent);
void display_show_error(const char *message);
void display_show_low_battery(void);

// Server mode: write raw pixel buffer
esp_err_t display_update_raw(const uint8_t *buffer, size_t len);

// Power management
esp_err_t display_sleep(void);
esp_err_t display_wake(void);
```

---

## Migration Plan

### Phase 1: Replace display drivers with esp_epaper
- Remove `firmware/components/vellum_display/drivers/` (E1001, E1002, E1003, Stub)
- Add `tuanpmt/esp_epaper` dependency
- Rewrite `vellum_display.c` to use `epd_init()` / `epd_update()`
- Keep existing `display_draw_pixel_buffer()` working (server mode)
- Test: Flash E1002, verify display initializes and shows content

### Phase 2: Add LVGL for local screens
- Initialize LVGL with `epd_lvgl_init()`
- Create boot screen (logo + version)
- Create WiFi setup screen (QR code + instructions)
- Create OTA progress screen
- Create error/status screens
- Test: Full boot flow without server

### Phase 3: Integrate with main firmware flow
- Boot → display_show_boot()
- No WiFi → display_show_wifi_setup()
- Connecting → display_show_connecting()
- Server found → switch to server mode (display_update_raw)
- OTA → display_show_ota_progress()
- Error → display_show_error()

### Phase 4: CI + Web Flash
- Update firmware build to produce merged binary (bootloader + partition + app)
- Update flash manifest for correct offsets
- Test web flash end-to-end

---

## Open Questions

1. **E1003 panel**: Which exact panel/controller? Need datasheet or GxEPD2 driver reference.
2. **Partial refresh for status updates**: GDEP073E01 doesn't support partial refresh. Status updates during server mode (e.g., "Connecting...") require full refresh (~15-30s). Consider using a small status area or LED/buzzer for quick feedback instead.
3. **LVGL memory**: 6-color LVGL buffer needs ~1.15 MB for dithering. ESP32-S3 has 8MB PSRAM — sufficient, but need to configure PSRAM allocation.
4. **Server buffer format**: Currently server sends palette-indexed bytes (1 byte per pixel for color). Should we switch to native 4-bit packed format to halve transfer size? Trade-off: server needs to pack, device needs no conversion.
