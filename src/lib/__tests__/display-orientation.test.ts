import { describe, it, expect } from "vitest";
import { resolveDisplayCaps } from "../display";

const portraitPanel = {
  model: "d1001",
  width: 800,
  height: 1280,
  palette: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  format: "jpeg",
  colorMode: "fullcolor",
};

describe("orientation resolution", () => {
  it("defaults to landscape instead of deriving a mounting from the geometry", () => {
    /* The regression this pins: a taller-than-wide panel used to read as "mounted
     * portrait" although the device never said so, which cost a D1001 480px off
     * the bottom of every frame. */
    const resolved = resolveDisplayCaps(portraitPanel);
    expect(resolved.orientation).toBe("landscape");
    expect([resolved.width, resolved.height]).toEqual([1280, 800]);
  });

  it("follows a mounting the device reports about itself", () => {
    const resolved = resolveDisplayCaps({ ...portraitPanel, orientation: "portrait" });
    expect(resolved.orientation).toBe("portrait");
    expect([resolved.width, resolved.height]).toEqual([800, 1280]);
  });

  it("lets the operator's choice win over the device's report", () => {
    const resolved = resolveDisplayCaps({ ...portraitPanel, orientation: "portrait" }, "landscape");
    expect(resolved.orientation).toBe("landscape");
    expect([resolved.width, resolved.height]).toEqual([1280, 800]);
  });

  it("defaults to landscape when there are no capabilities at all", () => {
    expect(resolveDisplayCaps(null).orientation).toBe("landscape");
  });
});
