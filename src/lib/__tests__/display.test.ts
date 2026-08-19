// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import { parseDisplayCapsHeader } from "../display";

/* The header carries untrusted device input and sizes render buffers, so the
 * failure cases matter as much as the happy path. */
describe("parseDisplayCapsHeader", () => {
  it("adopts a landscape surface and the mountings it supports", () => {
    expect(parseDisplayCapsHeader("1280x800;landscape;landscape")).toEqual({
      width: 1280,
      height: 800,
      orientation: "landscape",
      orientations: ["landscape"],
      backlight: false,
    });
  });

  it("keeps both mountings when the panel offers them", () => {
    expect(parseDisplayCapsHeader("800x1280;portrait;portrait,landscape")).toEqual({
      width: 800,
      height: 1280,
      orientation: "portrait",
      orientations: ["portrait", "landscape"],
      backlight: false,
    });
  });

  it("includes the current mounting even when the list omits it", () => {
    expect(parseDisplayCapsHeader("800x1280;portrait;")?.orientations).toEqual(["portrait"]);
  });

  it("rejects junk rather than resizing a panel", () => {
    for (const value of [
      null,
      "",
      "1280x800",
      "1280;landscape;landscape",
      "0x800;landscape;landscape",
      "9999x9999;landscape;landscape",
      "1280x800;sideways;landscape",
      "twelvex800;landscape;landscape",
    ]) {
      expect(parseDisplayCapsHeader(value)).toBeNull();
    }
  });

  it("drops unknown entries from the supported list", () => {
    expect(
      parseDisplayCapsHeader("1280x800;landscape;landscape,upside-down")?.orientations
    ).toEqual(["landscape"]);
  });
});
