// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Renderer-level checks for the name plate's optional unit and position.
 *
 * The layout tests cover the line count; these cover what actually reaches the
 * panel. Two properties are worth asserting against real pixels rather than
 * against arithmetic: an empty field must change nothing at all, and a filled one
 * must be drawn. Neither is observable from `bandContent` alone, because the type
 * size is chosen from the line count and the drawing happens afterwards.
 */

import { describe, it, expect } from "vitest";
import { namePlateRenderer } from "../name-plate";
import { resolveTheme, snapThemeToPalette } from "@/lib/theme";
import { DISPLAY_REGISTRY } from "@/lib/display";
import type { RenderParams } from "../../types";
import type { ResolvedDisplay } from "@/lib/display";

/* The six-colour panel, deliberately. The mono panel's built-in theme resolves
 * its text colours to white on white, so nothing there would be measurable. */
const reg = DISPLAY_REGISTRY.e1002;

const display: ResolvedDisplay = {
  width: reg.width,
  height: reg.height,
  palette: reg.palette,
  reservedPaletteIndices: reg.reservedPaletteIndices ?? [],
  format: reg.format,
  colorMode: reg.colorMode,
  colorCount: reg.palette.length,
  orientation: "landscape",
};

const theme = snapThemeToPalette(resolveTheme(display.colorCount), display.palette);

async function render(occupant: Record<string, unknown>): Promise<Buffer> {
  const params: RenderParams = {
    config: {
      roomName: "1J.2.27",
      seats: [{ caption: "", occupant: { kind: "static", name: "Schmieder", ...occupant } }],
      showStatus: false,
      locale: "de",
    },
    theme,
    display,
    now: new Date(Date.UTC(2026, 7, 23, 11, 42)),
    timezone: "Europe/Berlin",
  };
  const { canvas } = await namePlateRenderer.render(params);
  return canvas.toBuffer("image/png");
}

describe("name plate: unit and position", () => {
  it("renders identically when both are empty", async () => {
    const bare = await render({});
    const empty = await render({ unit: "", role: "" });
    expect(empty.equals(bare)).toBe(true);
  });

  /* Whitespace is the case an operator produces by accident, and a plate that
   * reserved a line for it would silently shrink the name. */
  it("renders identically when both are whitespace", async () => {
    const bare = await render({});
    const blank = await render({ unit: "   ", role: "\t" });
    expect(blank.equals(bare)).toBe(true);
  });

  it("draws something more when they are filled", async () => {
    const bare = await render({});
    const filled = await render({ unit: "Präsidium", role: "Vizepräsident" });
    expect(filled.equals(bare)).toBe(false);
  });
});
