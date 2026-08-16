# Vellum brand assets

These four SVGs are the canonical Vellum artwork. Use `mark` when the word
Vellum is already present next to it, and `logo` for a standalone lockup.
Choose `on-light` or `on-dark` for the actual surface; never recolor or invert
the artwork in CSS.

The canonical palette is:

- Vellum magenta: `#e9177b`
- warm light ink: `#e5dfe3`
- graphite ink: `#363434`
- structural gray: `#8f8e93`
- app-icon background: `#0a0a0f`

`src/app/icon.svg` is the derived dark app tile. Run
`./assets/render-brand-assets.sh` to regenerate its PNG/ICO outputs and the
hardware-specific mono, grayscale, and color LVGL assets. Set
`BRAND_PREVIEW_DIR=/tmp/vellum-brand` to retain review PNGs outside the repo.
