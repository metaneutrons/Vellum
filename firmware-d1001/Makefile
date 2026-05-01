# SPDX-License-Identifier: AGPL-3.0-or-later
# Vellum D1001 Firmware Makefile

SHELL := /bin/bash
PORT ?= /dev/cu.usbserial-110
BAUD ?= 460800

.PHONY: build flash monitor fm clean

build:
	source ~/.espressif/v6.0/esp-idf/export.sh > /dev/null 2>&1 && \
	idf.py build

flash:
	source ~/.espressif/v6.0/esp-idf/export.sh > /dev/null 2>&1 && \
	idf.py -p $(PORT) -b $(BAUD) flash

monitor:
	source ~/.espressif/v6.0/esp-idf/export.sh > /dev/null 2>&1 && \
	idf.py -p $(PORT) monitor

fm: flash monitor

clean:
	source ~/.espressif/v6.0/esp-idf/export.sh > /dev/null 2>&1 && \
	idf.py fullclean
