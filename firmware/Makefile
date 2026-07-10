# Vellum Firmware — Build & Flash
#
# Usage:
#   make build                    # Build for default model (E1002)
#   make build MODEL=e1001        # Build for E1001
#   make build MODEL=d1001        # Build for D1001 (ESP32-P4)
#   make flash                    # Flash via USB
#   make monitor                  # Serial monitor
#   make fm                       # Flash + monitor
#   make erase-nvs                # Erase NVS only (keeps firmware)
#   make erase-all                # Full erase + flash
#   make merged-bin               # Create single binary for web flash
#   make clean                    # Clean build

SHELL := /bin/bash

# Auto-detect serial port
PORT ?= $(shell ls /dev/cu.usbserial-* /dev/cu.wchusbserial* /dev/cu.usbmodem* 2>/dev/null | head -1)
BAUD ?= 460800
MODEL ?= e1002

# Map model to target chip and panel Kconfig
ifeq ($(MODEL),d1001)
  TARGET_CHIP = esp32p4
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.p4
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_D1001=y
else ifeq ($(MODEL),e1001)
  TARGET_CHIP = esp32s3
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.s3
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_GDEY075T7=y
else ifeq ($(MODEL),e1002)
  TARGET_CHIP = esp32s3
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.s3
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_GDEP073E01=y
else ifeq ($(MODEL),e1003)
  TARGET_CHIP = esp32s3
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.s3
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_E1003=y
else
  $(error Unknown MODEL=$(MODEL). Use d1001, e1001, e1002, or e1003)
endif

# ESP-IDF environment
IDF_ACTIVATE := source /Users/fabian/.espressif/tools/activate_idf_v6.0.sh > /dev/null 2>&1
IDF_ENV := export IDF_PATH=/Volumes/Dev/esp-idf/v6.0/esp-idf && export IDF_PYTHON_ENV_PATH=/Users/fabian/.espressif/tools/python/v6.0/venv

.PHONY: build flash monitor fm erase-nvs erase-all merged-bin clean check-port

build:
	@echo "Building for $(MODEL) ($(TARGET_CHIP))..."
	@$(IDF_ACTIVATE) && $(IDF_ENV) && \
		cp $(SDKCONFIG_DEFAULTS) sdkconfig.defaults && \
		grep -q "$(PANEL_CONFIG)" sdkconfig.defaults 2>/dev/null || echo "$(PANEL_CONFIG)" >> sdkconfig.defaults && \
		python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) set-target $(TARGET_CHIP) && \
		python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) build

flash: check-port
	@echo "Flashing $(MODEL) to $(PORT)..."
ifeq ($(TARGET_CHIP),esp32p4)
	@cd build && \
		espflash write-bin --chip $(TARGET_CHIP) --port $(PORT) --baud $(BAUD) 0x2000 bootloader/bootloader.bin && \
		espflash write-bin --chip $(TARGET_CHIP) --port $(PORT) --baud $(BAUD) 0x8000 partition_table/partition-table.bin && \
		espflash write-bin --chip $(TARGET_CHIP) --port $(PORT) --baud $(BAUD) 0x10000 ota_data_initial.bin && \
		espflash write-bin --chip $(TARGET_CHIP) --port $(PORT) --baud $(BAUD) 0x20000 vellum-$(MODEL).bin
else
	@$(IDF_ACTIVATE) && $(IDF_ENV) && python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) -p $(PORT) -b $(BAUD) flash
endif

flash-app: check-port
	@echo "Flashing app only to $(PORT)..."
ifeq ($(TARGET_CHIP),esp32p4)
	@espflash write-bin --chip $(TARGET_CHIP) --port $(PORT) --baud $(BAUD) 0x20000 build/vellum-$(MODEL).bin
else
	@$(IDF_ACTIVATE) && $(IDF_ENV) && python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) -p $(PORT) -b $(BAUD) app-flash
endif

monitor: check-port
	@$(IDF_ACTIVATE) && $(IDF_ENV) && python $$IDF_PATH/tools/idf.py -p $(PORT) monitor

# Flash + Monitor (most common dev workflow)
fm: flash monitor

erase-nvs: check-port
	@echo "Erasing NVS on $(PORT)..."
	@$(IDF_ACTIVATE) && $(IDF_ENV) && parttool.py --port $(PORT) erase_partition --partition-name nvs
	@echo "NVS erased. Reset the device."

erase-all: check-port
	@echo "Full erase + flash on $(PORT)..."
	@espflash erase-flash --port $(PORT) && $(MAKE) flash

# Create merged binary for web flash (single file, offset 0x0)
merged-bin: build
	@echo "Creating merged binary..."
	@$(IDF_ACTIVATE) && $(IDF_ENV) && cd build && \
		esptool --chip $(TARGET_CHIP) merge-bin \
			--output vellum-$(MODEL)-merged.bin \
			@flash_args
	@echo "Created: build/vellum-$(MODEL)-merged.bin"
	@ls -lh build/vellum-$(MODEL)-merged.bin

clean:
	@rm -rf build managed_components sdkconfig
	@echo "Clean."

check-port:
	@if [ -z "$(PORT)" ]; then \
		echo "Error: No serial port found. Connect device via USB or set PORT="; \
		exit 1; \
	fi
	@echo "Using port: $(PORT)"
