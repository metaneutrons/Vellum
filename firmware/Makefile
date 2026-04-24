# Vellum Firmware — Build System
# Wraps idf.py for convenience. Requires ESP-IDF v5.3+ in PATH.
#
# Usage:
#   make setup       — install ESP-IDF and set target
#   make build       — compile firmware
#   make flash       — flash to connected device
#   make monitor     — open serial monitor
#   make fm          — flash + monitor (most common during dev)
#   make clean       — remove build artifacts
#   make menuconfig  — open Kconfig GUI
#   make erase       — erase entire flash (factory reset)
#   make size        — show binary size breakdown

SHELL      := /bin/zsh
IDF_PY     := idf.py
TARGET     := esp32s3
PORT       ?= /dev/cu.usbmodem*
BAUD       ?= 460800
IDF_PATH   ?= $(HOME)/esp/esp-idf
IDF_TOOLS  := $(HOME)/.espressif

.PHONY: all setup check-idf build flash monitor fm clean fullclean \
        menuconfig erase size ota help

all: build

# ── Environment ──────────────────────────────────────────────────────────

check-idf:
	@if ! command -v $(IDF_PY) &>/dev/null; then \
		echo "❌  idf.py not found. Run 'make setup' first or source ESP-IDF export.sh"; \
		exit 1; \
	fi

setup:
	@echo "── Installing ESP-IDF v5.3 ──"
	@if [ ! -d "$(IDF_PATH)" ]; then \
		mkdir -p $(dir $(IDF_PATH)); \
		git clone --branch v5.3 --depth 1 --recursive \
			https://github.com/espressif/esp-idf.git $(IDF_PATH); \
	else \
		echo "ESP-IDF already present at $(IDF_PATH)"; \
	fi
	@echo "── Installing toolchain ──"
	$(IDF_PATH)/install.sh $(TARGET)
	@echo "── Setting target ──"
	@. $(IDF_PATH)/export.sh && $(IDF_PY) set-target $(TARGET)
	@echo ""
	@echo "✅  Setup complete. Add this to your shell profile:"
	@echo "    source $(IDF_PATH)/export.sh"

# ── Build ────────────────────────────────────────────────────────────────

build: check-idf
	$(IDF_PY) build

menuconfig: check-idf
	$(IDF_PY) menuconfig

size: check-idf
	$(IDF_PY) size-components

# ── Flash & Monitor ─────────────────────────────────────────────────────

flash: check-idf
	$(IDF_PY) -p $(PORT) -b $(BAUD) flash

monitor: check-idf
	$(IDF_PY) -p $(PORT) -b 115200 monitor

fm: check-idf
	$(IDF_PY) -p $(PORT) -b $(BAUD) flash monitor

erase: check-idf
	$(IDF_PY) -p $(PORT) erase-flash

# ── Clean ────────────────────────────────────────────────────────────────

clean: check-idf
	$(IDF_PY) fullclean

fullclean:
	rm -rf build sdkconfig

# ── Help ─────────────────────────────────────────────────────────────────

help:
	@echo "Vellum Firmware Build Targets"
	@echo ""
	@echo "  setup       Install ESP-IDF v5.3 + toolchain, set target to $(TARGET)"
	@echo "  build       Compile firmware"
	@echo "  flash       Flash to device on $(PORT)"
	@echo "  monitor     Open serial monitor"
	@echo "  fm          Flash + monitor (dev workflow)"
	@echo "  menuconfig  Open Kconfig configuration GUI"
	@echo "  size        Show binary size breakdown by component"
	@echo "  erase       Erase entire flash (factory reset)"
	@echo "  clean       Remove build directory"
	@echo "  fullclean   Remove build + sdkconfig"
	@echo ""
	@echo "Variables:"
	@echo "  PORT=$(PORT)    Serial port (override: make flash PORT=/dev/cu.usbserial-XXX)"
	@echo "  BAUD=$(BAUD)          Flash baud rate"
	@echo "  IDF_PATH=$(IDF_PATH)"
