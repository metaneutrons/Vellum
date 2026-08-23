// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The narrow cut is optional, so its ABSENCE has to be reported honestly.
 *
 * This is not a hypothetical. `GlobalFonts.registerFromPath` answers `false` for a
 * file that is not there rather than throwing, so an earlier version wrapped it in
 * a try/catch, saw no exception, and declared the family available. Canvas then
 * substituted whatever the host machine had, the size search preferred it because
 * it measured 18 % narrower than Inter, and a door sign would have been set in an
 * arbitrary system face.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ensureRenderFonts, narrowFontFamily, RENDER_FONT_FAMILY } from "../fonts";

const FONT_DIR = path.join(process.cwd(), "assets/fonts");
const narrowInstalled = ["VellumNarrow-Regular.ttf", "VellumNarrow-Bold.ttf"].every((f) =>
  fs.existsSync(path.join(FONT_DIR, f))
);

describe("render fonts", () => {
  it("registers the body family", () => {
    expect(ensureRenderFonts()).toBe(RENDER_FONT_FAMILY);
  });

  it("reports the narrow family only when both of its files are present", () => {
    expect(narrowFontFamily() !== null).toBe(narrowInstalled);
  });
});
