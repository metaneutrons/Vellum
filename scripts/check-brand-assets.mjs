// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const masters = [
  "public/brand/vellum-mark-on-light.svg",
  "public/brand/vellum-mark-on-dark.svg",
  "public/brand/vellum-logo-on-light.svg",
  "public/brand/vellum-logo-on-dark.svg",
];
const generated = [
  "firmware/components/vellum_display/logos/vellum_logo_mono_216px.c",
  "firmware/components/vellum_display/logos/vellum_logo_16grey_600px.c",
  "firmware/components/vellum_display/logos/vellum_logo_color_360px.c",
  "src/app/apple-icon.png",
  "src/app/favicon.ico",
];
const failures = [];

for (const file of [...masters, ...generated]) {
  if (!existsSync(file)) failures.push(`missing required brand asset: ${file}`);
}
for (const file of masters) {
  const source = readFileSync(file, "utf8").toLowerCase();
  if (!source.includes("#e9177b") || !source.includes("#8f8e93")) {
    failures.push(`${file} does not use the canonical palette`);
  }
  const expectedInk = file.endsWith("on-light.svg") ? "#363434" : "#e5dfe3";
  if (!source.includes(expectedInk)) failures.push(`${file} is missing ${expectedInk}`);
}

// The D1001 panel consumes native RGB565. LVGL indexed assets compile but are
// invisible on this MIPI-DSI path, so guard the generated descriptor in CI.
const d1001Logo = readFileSync(
  "firmware/components/vellum_display/logos/vellum_logo_color_360px.c",
  "utf8"
);
if (!d1001Logo.includes(".header.cf = LV_COLOR_FORMAT_RGB565")) {
  failures.push("D1001 logo must be generated as native LV_COLOR_FORMAT_RGB565");
}

const textExtensions = new Set([".c", ".css", ".html", ".md", ".mjs", ".sh", ".svg", ".tsx"]);
const legacyPatterns = [
  /#183157/i,
  /#1c8a8f/i,
  /vellum-(?:logo|icon)\.svg/,
  /vellum_logo(?:_light)?\.svg/,
  /dark:invert/,
];
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (textExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      const source = readFileSync(path, "utf8");
      for (const pattern of legacyPatterns) {
        if (pattern.test(source)) failures.push(`${path} contains legacy brand token ${pattern}`);
      }
    }
  }
}
for (const directory of ["assets", "firmware/components/wifi_manager", "public", "src"])
  scan(directory);
for (const pattern of legacyPatterns) {
  if (pattern.test(readFileSync("README.md", "utf8")))
    failures.push(`README.md contains legacy brand token ${pattern}`);
}

const looseRasterLogos = readdirSync("assets").filter((file) =>
  /^vellum_(?:logo|icon).*\.(?:png|jpe?g)$/i.test(file)
);
if (looseRasterLogos.length)
  failures.push(`loose raster logo derivatives: ${looseRasterLogos.join(", ")}`);

if (failures.length) {
  for (const failure of failures) console.error(`✖ ${failure}`);
  process.exit(1);
}
console.error("✔ Vellum brand masters, usage, and generated targets are consistent.");
