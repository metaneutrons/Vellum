# Vellum Firmware — Build & Flash
#
# Usage:
#   make build                    # Build for default model (E1002)
#   make build MODEL=e1001        # Build for E1001
#   make flash                    # Flash via USB
#   make monitor                  # Serial monitor
#   make fm                       # Flash + monitor
#   make erase-nvs                # Erase NVS only (keeps firmware)
#   make erase-all                # Full erase + flash
#   make merged-bin               # Create single binary for web flash
#   make clean                    # Clean build

SHELL := /bin/bash

# Auto-detect serial port
PORT ?= $(shell ls /dev/cu.usbserial-* 2>/dev/null | head -1)
MODEL ?= e1002

# Map model to Kconfig
ifeq ($(MODEL),e1001)
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_GDEY075T7=y
else ifeq ($(MODEL),e1002)
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_GDEP073E01=y
else
  $(error Unknown MODEL=$(MODEL). Use e1001 or e1002)
endif

# ESP-IDF environment
IDF_EXPORT := source $${HOME}/.espressif/v6.0/esp-idf/export.sh > /dev/null 2>&1

.PHONY: build flash monitor fm erase-nvs erase-all merged-bin clean check-port

build:
	@echo "Building for $(MODEL)..."
	@$(IDF_EXPORT) && \
		grep -q "$(PANEL_CONFIG)" sdkconfig.defaults 2>/dev/null || \
		(sed -i '' '/CONFIG_VELLUM_PANEL_/d' sdkconfig.defaults && echo "$(PANEL_CONFIG)" >> sdkconfig.defaults) && \
		idf.py set-target esp32s3 && \
		idf.py build

flash: check-port
	@echo "Flashing to $(PORT)..."
	@$(IDF_EXPORT) && idf.py -p $(PORT) flash

monitor: check-port
	@$(IDF_EXPORT) && idf.py -p $(PORT) monitor

# Flash + Monitor (most common dev workflow)
fm: check-port
	@echo "Flashing to $(PORT)..."
	@$(IDF_EXPORT) && idf.py -p $(PORT) flash monitor

erase-nvs: check-port
	@echo "Erasing NVS on $(PORT)..."
	@$(IDF_EXPORT) && parttool.py --port $(PORT) erase_partition --partition-name nvs
	@echo "NVS erased. Reset the device."

erase-all: check-port
	@echo "Full erase + flash on $(PORT)..."
	@$(IDF_EXPORT) && esptool.py --port $(PORT) erase_flash && idf.py -p $(PORT) flash

# Create merged binary for web flash (single file, offset 0x0)
merged-bin: build
	@echo "Creating merged binary..."
	@$(IDF_EXPORT) && cd build && \
		esptool --chip esp32s3 merge-bin \
			--output vellum-$(MODEL)-merged.bin \
			@flash_args
	@echo "Created: build/vellum-$(MODEL)-merged.bin"
	@ls -lh build/vellum-$(MODEL)-merged.bin

clean:
	@rm -rf build managed_components
	@echo "Clean."

check-port:
	@if [ -z "$(PORT)" ]; then \
		echo "Error: No serial port found. Connect device via USB or set PORT="; \
		exit 1; \
	fi
	@echo "Using port: $(PORT)"
