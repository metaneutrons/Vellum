# Firmware Refactor — Task List

## Phase 1: Display Layer (esp_epaper + LVGL) ✅

- [x] Integrate `tuanpmt/esp_epaper` component (GDEP073E01)
- [x] Rewrite `vellum_display.c` — init, raw buffer update, sleep/wake
- [x] LVGL 9 integration — combined init screen (logo + QR + instructions)
- [x] LVGL error screen with large icon + text (48pt)
- [x] LVGL OTA progress screen with progress bar
- [x] PSRAM enabled for framebuffer + LVGL buffers
- [x] Verify E1002 display works end-to-end on real hardware

## Phase 2: Device Configuration (Improv + Console) ✅

- [x] Implement Improv WiFi Serial protocol (binary packets)
- [x] Improv WiFi handler — receive SSID/password/server URL, store in NVS
- [x] ESP Console serial shell (text commands)
- [x] Console commands: `wifi`, `server`, `info`, `nvs-erase`, `reboot`
- [x] Both protocols share same USB-UART, auto-detected

## Phase 3: Build System (Makefile + CI) ✅

- [x] `firmware/Makefile` — build, flash, monitor, fm, erase-nvs, erase-all, merged-bin, clean
- [x] `make build MODEL=e1002` — build for specific model
- [x] `make flash` — auto-detect serial port
- [x] `make merged-bin` — single binary for web flash
- [x] CI firmware workflow produces merged binary
- [x] Web flash via ESP Web Tools with binary proxy (CORS bypass)

## Phase 4: Firmware Quality ✅

- [x] Button handlers: Green=wake+refresh, KEY2+KEY0 5s=factory reset
- [x] HTTP retry logic (3 attempts with exponential backoff)
- [x] Graceful fallback when server unreachable (error screen, sleep, retry)
- [x] Deep sleep wake sources (timer + green button GPIO only)
- [x] SoftAP only on no-credentials or factory reset
- [x] ETag/If-None-Match for content caching (skip refresh if unchanged)
- [x] ETag + last screen persisted in NVS (survives deep sleep)
- [x] Skip boot screen on timer wake (direct to server render)
- [x] Display capabilities sent in hello request (model, palette, quantize)
- [x] 4-bit packed pixel format for 6-color displays (192KB vs 384KB)
- [x] Telemetry on every API call (hello, config, render, report)
- [x] lastSeen updated on every telemetry log

## Phase 5: Panels, Version-Sync & Provisioning UI ✅

- [x] E1001 (BW) panel support — `panel_epaper.c` GDEY075T7 via the `UC8179_BW` controller (vendored `epaper_uc8179` fork, `uc8179_bw.c`)
- [x] E1003 (10.3") panel support — ED103TC2 driven by IT8951, **16-gray / 4bpp (GC16), 1404×1872** (not "Mono"); `panel_epaper.c` + `epaper_it8951`/`ed103tc2.c`
- [x] Firmware version sync via release-please — `firmware` component → `Kconfig.projbuild` `CONFIG_VELLUM_FIRMWARE_VERSION` (`# x-release-please-version`, current 1.2.1)
- [x] Admin provisioning UI — Improv provisioning over the **Web Serial API** (`src/app/admin/firmware/provision/provision-tool.tsx`), **not** ESP Web Tools. The "Setup Device in one flow" goal ships as **two adjacent pages**: **Flash** (`flash-tool.tsx`, ESP Web Tools) then **Provision** (`provision-tool.tsx`, Web Serial)

## Remaining / Future

- [ ] OTA update flow end-to-end verification
