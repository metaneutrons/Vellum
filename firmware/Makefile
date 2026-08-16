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
# Keep ESP-IDF's app descriptor and Vellum's runtime version on one release
# value for local/manual builds too. CI injects the same value explicitly.
FIRMWARE_VERSION := $(shell awk '/config VELLUM_FIRMWARE_VERSION/{f=1;next} f&&/default "/{gsub(/^.*default "|".*$$/,"");print;exit}' main/Kconfig.projbuild)
MODEL_DEFAULTS =
DEV_HTTP ?= 0
DEV_DEFAULTS =

# ── Secure Boot / signed-verify build profiles (OPT-IN — SECURE=1) ──────────
# The default `make build` is byte-unchanged (unsigned, reflashable). SECURE=1
# builds via an sdkconfig overlay CHAIN instead, climbing a 3-rung ladder — prove
# each rung on a spare board before the next (see docs/SECURE_BOOT_AND_KMS.md):
#   testsecure — software signature verify, NO eFuse burn (fully reversible)
#   secureboot — Secure Boot v2 on, Flash-Enc OFF (first eFuse burns; reflashable)
#   prod       — + Flash Encryption RELEASE + anti-rollback (POINT OF NO RETURN)
# Overlays set BUILD_SIGNED_BINARIES=n → no private key on the build host; sign
# the image out-of-band with `espsecure.py sign_data --version 2 --hsm` (KMS).
# SECURE_PROFILE defaults to the fully-reversible `testsecure` (no eFuse burn);
# the eFuse-burning rungs must be selected explicitly (fail-safe default).
SECURE ?= 0
SECURE_PROFILE ?= testsecure

# Map model to target chip and panel Kconfig
ifeq ($(MODEL),d1001)
  TARGET_CHIP = esp32p4
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.p4
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_D1001=y
else ifeq ($(MODEL),e1001)
  TARGET_CHIP = esp32s3
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.s3
  MODEL_DEFAULTS = sdkconfig.defaults.e1001
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_GDEY075T7=y
else ifeq ($(MODEL),e1002)
  TARGET_CHIP = esp32s3
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.s3
  MODEL_DEFAULTS = sdkconfig.defaults.e1002
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_GDEP073E01=y
else ifeq ($(MODEL),e1003)
  TARGET_CHIP = esp32s3
  SDKCONFIG_DEFAULTS = sdkconfig.defaults.s3
  MODEL_DEFAULTS = sdkconfig.defaults.e1003
  PANEL_CONFIG = CONFIG_VELLUM_PANEL_E1003=y
else
  $(error Unknown MODEL=$(MODEL). Use d1001, e1001, e1002, or e1003)
endif

ifeq ($(DEV_HTTP),1)
  DEV_DEFAULTS = sdkconfig.defaults.dev-http
endif

# Common target defaults plus an optional model-specific hardware overlay.
# sdkconfig.panel remains generated because the selected display is a build
# input, not persistent source configuration.
SDKCONFIG_CHAIN = $(SDKCONFIG_DEFAULTS)$(if $(MODEL_DEFAULTS),;$(MODEL_DEFAULTS))$(if $(DEV_DEFAULTS),;$(DEV_DEFAULTS))

# ESP-IDF environment
IDF_ACTIVATE := source /Users/fabian/.espressif/tools/activate_idf_v6.0.sh > /dev/null 2>&1
IDF_ENV := export IDF_PATH=/Volumes/Dev/esp-idf/v6.0/esp-idf && export IDF_PYTHON_ENV_PATH=/Users/fabian/.espressif/tools/python/v6.0/venv

.PHONY: build flash monitor fm erase-nvs erase-all merged-bin clean check-port

build:
	@printf '%s\n' "$(FIRMWARE_VERSION)" > version.txt
ifeq ($(SECURE),1)
	@echo "SECURE build ($(SECURE_PROFILE)) for $(MODEL) ($(TARGET_CHIP))..."
	@if [ "$(TARGET_CHIP)" = "esp32p4" ]; then \
		echo "ERROR: Secure Boot profiles are ESP32-S3 only for now (P4 key spec differs)."; exit 1; fi
	@if [ ! -f "sdkconfig.defaults.$(SECURE_PROFILE)" ]; then \
		echo "ERROR: no overlay sdkconfig.defaults.$(SECURE_PROFILE) (use testsecure|secureboot|prod)"; exit 1; fi
	@printf '%s\n' "$(PANEL_CONFIG)" > sdkconfig.panel
	@rm -f sdkconfig   # force a fresh reconfigure so secure flags can't silently stay off
	@$(IDF_ACTIVATE) && $(IDF_ENV) && \
		CHAIN="$(SDKCONFIG_CHAIN);sdkconfig.panel;sdkconfig.defaults.$(SECURE_PROFILE)"; \
		python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) -DSDKCONFIG_DEFAULTS="$$CHAIN" set-target $(TARGET_CHIP) && \
		python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) build; \
		rc=$$?; rm -f sdkconfig.panel; [ $$rc -eq 0 ] || exit $$rc   # clean up even on failure
	@grep -qE "^CONFIG_(SECURE_BOOT|SECURE_SIGNED_APPS)=y" sdkconfig || { \
		echo "ERROR: secure flags absent from generated sdkconfig — overlay not applied"; exit 1; }
	@echo "SECURE build OK — image is NOT yet signed; sign out-of-band before flashing (see runbook)."
else
	@echo "Building for $(MODEL) ($(TARGET_CHIP))..."
	@rm -f sdkconfig sdkconfig.panel
	@printf '%s\n' "$(PANEL_CONFIG)" > sdkconfig.panel
	@$(IDF_ACTIVATE) && $(IDF_ENV) && \
		python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) -DSDKCONFIG_DEFAULTS="$(SDKCONFIG_CHAIN);sdkconfig.panel" set-target $(TARGET_CHIP) && \
		python $$IDF_PATH/tools/idf.py -DVELLUM_MODEL=$(MODEL) -DSDKCONFIG_DEFAULTS="$(SDKCONFIG_CHAIN);sdkconfig.panel" build
endif

flash: check-port
	@echo "Flashing $(MODEL) to $(PORT)..."
# ESP32-P4: flash each image explicitly with espflash (idf.py flash is unreliable
# on the P4 USB-Serial-JTAG download path in this toolchain). Offsets MUST mirror
# partitions.csv — bootloader 0x2000 (P4 boots at 0x2000, not 0x0), partition
# table 0x8000, otadata 0x10000, app/ota_0 0x20000. NOTE: these are the non-secure
# offsets; SECURE builds are blocked on P4 (see the build target above), so the
# partitions.secure.csv layout intentionally isn't handled here.
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
