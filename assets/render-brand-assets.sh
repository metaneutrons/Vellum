#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#
# Rebuild every rasterized Vellum brand asset from the four canonical SVGs in
# public/brand. Intermediate PNGs live only in a temporary directory; the repo
# stores semantic masters, application icons, and the LVGL outputs it compiles.
#
# Requires: rsvg-convert, python3 + Pillow, and png2lvgl
#           (https://github.com/metaneutrons/png2lvgl).
set -Eeuo pipefail

PNG2LVGL="${1:-$HOME/Source/png2lvgl/target/release/png2lvgl}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAND="${ROOT}/public/brand"
LOGOS="${ROOT}/firmware/components/vellum_display/logos"
WORK="$(mktemp -d)"
PREVIEW_DIR="${BRAND_PREVIEW_DIR:-}"
trap 'rm -rf "$WORK"' EXIT

command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found" >&2; exit 1; }
[[ -x "$PNG2LVGL" ]] || { echo "png2lvgl not found at $PNG2LVGL" >&2; exit 1; }

clean_generated() {
  sed -i.bak 's/[[:blank:]]*$//' "$1"
  rm -f "$1.bak"
}

publish_preview() {
  [[ -n "$PREVIEW_DIR" ]] || return 0
  mkdir -p "$PREVIEW_DIR"
  cp "$1" "$PREVIEW_DIR/"
}

render_logo() {
  local svg="$1" height="$2" bg="$3" out="$4" mode="$5"
  rsvg-convert -h 2048 "$svg" -o "${WORK}/raw.png"
  python3 - "${WORK}/raw.png" "$height" "$bg" "$out" "$mode" <<'PY'
import sys
from PIL import Image

raw, height, bg, out, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
image = Image.open(raw).convert("RGBA")
image = image.crop(image.split()[-1].getbbox())
width = round(height * image.size[0] / image.size[1])
image = image.resize((width, height), Image.Resampling.LANCZOS)
flat = Image.new("RGB", (width, height), (255, 255, 255) if bg == "white" else (0, 0, 0))
flat.paste(image, (0, 0), image)
if mode == "mono":
    flat = flat.convert("L").point(lambda value: 255 if value > 140 else 0, mode="1")
elif mode == "gray16":
    flat = flat.convert("L").point(lambda value: round(value / 17) * 17).convert("RGB")
elif mode == "color":
    flat = flat.quantize(colors=256, method=Image.Quantize.MEDIANCUT).convert("RGB")
flat.save(out)
print(f"  {out.rsplit('/', 1)[-1]}  {width}x{height}")
PY
}

# Logo height is 45% of every panel. Each target keeps only the color depth its
# hardware can display; all three derive from the same magenta master family.
echo "E1001/E1002: 1-bit logo on white"
render_logo "${BRAND}/vellum-logo-on-light.svg" 216 white \
  "${WORK}/vellum_logo_mono_216px.png" mono
publish_preview "${WORK}/vellum_logo_mono_216px.png"
"$PNG2LVGL" "${WORK}/vellum_logo_mono_216px.png" -f indexed1 --overwrite \
  -o "${LOGOS}/vellum_logo_mono_216px.c"
clean_generated "${LOGOS}/vellum_logo_mono_216px.c"

echo "E1003: 16-gray logo on white"
render_logo "${BRAND}/vellum-logo-on-light.svg" 636 white \
  "${WORK}/vellum_logo_16grey_600px.png" gray16
publish_preview "${WORK}/vellum_logo_16grey_600px.png"
"$PNG2LVGL" "${WORK}/vellum_logo_16grey_600px.png" -f indexed4 --overwrite \
  -o "${LOGOS}/vellum_logo_16grey_600px.c"
clean_generated "${LOGOS}/vellum_logo_16grey_600px.c"

echo "D1001: full-color logo on black"
render_logo "${BRAND}/vellum-logo-on-dark.svg" 360 black \
  "${WORK}/vellum_logo_color_360px.png" color
publish_preview "${WORK}/vellum_logo_color_360px.png"
# D1001's RGB565 framebuffer cannot reliably display LVGL indexed images; an
# indexed8 regeneration made the logo invisible in firmware 1.4.7. Keep this
# target in its native framebuffer format so brand regeneration cannot regress
# the hardware again.
"$PNG2LVGL" "${WORK}/vellum_logo_color_360px.png" -f true-color --overwrite \
  -o "${LOGOS}/vellum_logo_color_360px.c"
clean_generated "${LOGOS}/vellum_logo_color_360px.c"

echo "Web application icons"
rsvg-convert -w 1024 -h 1024 "${ROOT}/src/app/icon.svg" -o "${WORK}/app-icon.png"
publish_preview "${WORK}/app-icon.png"
python3 - "${WORK}/app-icon.png" "${ROOT}/src/app/apple-icon.png" "${ROOT}/src/app/favicon.ico" <<'PY'
import sys
from PIL import Image

source, apple, favicon = sys.argv[1:]
image = Image.open(source).convert("RGBA")
image.resize((180, 180), Image.Resampling.LANCZOS).save(apple)
image.save(favicon, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
PY
