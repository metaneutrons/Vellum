#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#
# Regenerate the two large LVGL fonts used by the E1003 status screens.
#
#   ./assets/render-fonts.sh
#
# ── Why these exist at all ────────────────────────────────────────────
#
# LVGL's bundled Montserrat family stops at 48px — there is no
# CONFIG_LV_FONT_MONTSERRAT_64 or _96 to switch on. E1003's panel is 1872x1404 at
# ~226 DPI, roughly 1.8x the pixel density of the 800x480 E-Series panels, so the
# 48px ceiling rendered status text at about a third of the intended optical size
# and left the font ladder (LG/MD/SM) with three identical rungs and nothing to
# step down to. These two pre-generated sizes give that panel its own ladder.
#
# ── Why pre-generated instead of scaled at runtime ────────────────────
#
# Same reason the logos are pre-rendered (assets/render-logos.sh): LVGL can only
# scale a bitmap font by resampling the rendered glyphs, which on e-paper is
# visibly blocky. Generating from the TTF at the target size is the only way to
# get clean stems and curves.
#
# ── Why these parameters ──────────────────────────────────────────────
#
# The TTF and the recipe are LVGL's own, taken verbatim from
# firmware/managed_components/lvgl__lvgl/scripts/built_in_font/ so the two extra
# sizes are consistent with the built-ins they sit alongside:
#   --bpp 4                  16 alpha levels, matching the 16-gray panel exactly
#   -r 0x20-0x7F,0xB0,0x2022 LVGL's default text range (ASCII + degree + bullet)
#   --no-compress            LVGL's built-ins are uncompressed; decompression
#                            would cost RAM on every draw
#
# Only SIX FontAwesome glyphs are included, not the 61 that the built-ins carry.
# That is the whole reason this is affordable: the full symbol set costs 181 KB at
# 96px against 70 KB for text alone. The six are the icons status_layout's screens
# can actually show (vellum_display.h vellum_display_icon_t) — adding an icon to
# that enum means adding its codepoint HERE and regenerating, or it renders as a
# missing glyph.
#
#   61468 0xF01C  DRIVE        server
#   61473 0xF021  REFRESH      in progress
#   61550 0xF06E  EYE_OPEN     pending approval
#   61553 0xF071  WARNING      error
#   61931 0xF1EB  WIFI         network
#   62020 0xF244  BATTERY_EMPTY battery
#
# Measured cost, for the record (96px / 64px glyph bitmaps):
#   ascii + all 61 symbols, bpp4   362 KB / 162 KB
#   ascii + all 61 symbols, bpp2   181 KB /  81 KB
#   ascii + 6 symbols,      bpp4   168 KB /  76 KB   <- what we ship
set -Eeuo pipefail

FW="$(cd "$(dirname "${BASH_SOURCE[0]}")/../firmware" && pwd)"
GEN="${FW}/managed_components/lvgl__lvgl/scripts/built_in_font"
OUT="${FW}/components/vellum_display/fonts"

[[ -d "$GEN" ]] || {
  echo "LVGL managed component not present — run a firmware build first so" >&2
  echo "idf_component_manager fetches lvgl__lvgl, then re-run this script." >&2
  exit 1
}

# Codepoints of the LV_SYMBOL_* glyphs the status screens use. Keep in sync with
# vellum_display_icon_t.
SYMBOLS="61468,61473,61550,61553,61931,62020"

mkdir -p "$OUT"
cd "$GEN"   # the TTF/WOFF paths below are relative, and so is -o, which keeps
            # the "Opts:" header comment in the generated file reproducible

for size in 64 96; do
  npx --yes lv_font_conv@1.5.2 \
    --no-compress --no-prefilter \
    --bpp 4 --size "$size" \
    --font Montserrat-Medium.ttf -r '0x20-0x7F,0xB0,0x2022' \
    --font FontAwesome5-Solid+Brands+Regular.woff -r "$SYMBOLS" \
    --format lvgl -o "vellum_font_montserrat_${size}.c" \
    --force-fast-kern-format
  mv "vellum_font_montserrat_${size}.c" "$OUT/"
  echo "  vellum_font_montserrat_${size}.c"
done

echo
echo "Generated .c files are committed; CI does not need lv_font_conv."
