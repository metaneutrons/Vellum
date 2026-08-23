// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The narrow cut is optional, so its ABSENCE has to be reported honestly.
 *
 * This is not hypothetical. `GlobalFonts.registerFromPath` answers `false` for a
 * file that is not there rather than throwing, so an earlier version wrapped it in
 * a try/catch, saw no exception and declared the family available. Canvas then
 * substituted whatever the host machine had, the size search preferred it because
 * it measured 18 % narrower than Inter, and a door sign would have been set in an
 * arbitrary system face.
 *
 * The rule is tested rather than the environment. An earlier version of this file
 * probed `assets/fonts` with `fs.existsSync` to establish ground truth, which is
 * both a path built at runtime in a test and an assertion whose MEANING flips the
 * day the face lands. `narrowIsComplete` carries the decision, so it can be pinned
 * without touching a disk.
 */

import { describe, it, expect } from "vitest";
import {
  ensureRenderFonts,
  narrowFontFamily,
  narrowIsComplete,
  NARROW_FONT_FAMILY,
  RENDER_FONT_FAMILY,
} from "../fonts";

describe("render fonts", () => {
  it("registers the body family", () => {
    expect(ensureRenderFonts()).toBe(RENDER_FONT_FAMILY);
  });

  describe("narrowIsComplete", () => {
    it("needs every weight to have registered", () => {
      expect(narrowIsComplete([true, true])).toBe(true);
      expect(narrowIsComplete([true, false])).toBe(false);
      expect(narrowIsComplete([false, true])).toBe(false);
      expect(narrowIsComplete([false, false])).toBe(false);
    });

    /* The edge that a bare `.every(Boolean)` gets wrong: an empty list is vacuously
     * true, so "no files configured" would have reported itself as available. */
    it("does not treat an empty list as success", () => {
      expect(narrowIsComplete([])).toBe(false);
    });
  });

  /* Either the face is installed and named, or it is absent and reported as null.
   * There is no third answer, and in particular never a family name backed by
   * nothing. */
  it("answers with the family or with null, never anything else", () => {
    const family = narrowFontFamily();
    expect(family === null || family === NARROW_FONT_FAMILY).toBe(true);
  });
});
