# Firmware Refactor — Task List

## Phase 1: Display Layer (esp_epaper + LVGL)
- [ ] Integrate `tuanpmt/esp_epaper` component (GDEP073E01 + GDEY075T7)
- [ ] Rewrite `vellum_display.c` — init, raw buffer update, sleep/wake
- [ ] LVGL 9 integration — boot screen with logo + version
- [ ] LVGL WiFi setup screen — QR code + SSID + instructions
- [ ] LVGL connecting screen
- [ ] LVGL OTA progress screen with progress bar
- [ ] LVGL error screen with icon + message
- [ ] LVGL low battery screen
- [ ] Verify E1002 display works end-to-end (local build + flash)
- [ ] Verify E1001 display works (if hardware available)

## Phase 2: Device Configuration (Improv + Console)
- [ ] Add `espressif/improv_serial` component
- [ ] Implement Improv WiFi handler — receive SSID/password, store in NVS, connect
- [ ] Extend Improv with custom command for server URL
- [ ] Add `esp_console` component for serial shell
- [ ] Console command: `wifi <ssid> <password>` — configure WiFi
- [ ] Console command: `server <url>` — set server URL
- [ ] Console command: `nvs show` — dump NVS contents
- [ ] Console command: `nvs erase` — factory reset
- [ ] Console command: `reboot` — restart device
- [ ] Console command: `info` — show MAC, firmware version, battery, RSSI
- [ ] Verify Improv works from ESP Web Tools in browser (auto-detected)
- [ ] Admin UI: "Setup Device" page combining flash + WiFi config in one flow

## Phase 3: Build System (Makefile + CI)
- [ ] Create `firmware/Makefile` with targets: build, flash, monitor, erase-nvs, full-flash, merged-bin
- [ ] `make build MODEL=e1002` — build for specific model
- [ ] `make flash PORT=/dev/cu.usbserial-110` — flash via USB
- [ ] `make monitor` — serial monitor
- [ ] `make erase-nvs` — erase NVS partition only
- [ ] `make merged-bin` — create single binary (bootloader + partition table + app) for web flash
- [ ] Update CI firmware workflow to produce merged binary
- [ ] Update flash-manifest to use merged binary at offset 0x0
- [ ] Verify web flash works end-to-end (browser → merged binary → device boots)
- [ ] Update `firmware/sdkconfig.defaults` — clean up, remove stale configs

## Phase 4: Firmware Quality
- [ ] Add error logging with structured tags (consistent ESP_LOGx usage)
- [ ] Add watchdog timeout handling for display operations
- [ ] Add retry logic for HTTP requests (hello, render, config)
- [ ] Add graceful fallback when server unreachable (show last rendered image or error)
- [ ] Verify OTA update flow end-to-end (server → device → reboot → new version)
- [ ] Verify deep sleep + wake cycle (battery life optimization)
- [ ] Test button handlers (KEY0=refresh, KEY1=report, KEY2=SoftAP)
