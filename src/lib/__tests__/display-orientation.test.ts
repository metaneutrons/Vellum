import { describe, it, expect } from "vitest";
import { resolveDisplayCaps, mergeReportedCaps } from "../display";

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

describe("reported surface on every authenticated poll", () => {
  const stored = {
    model: "d1001",
    width: 800,
    height: 1280,
    orientation: "portrait",
    orientations: ["landscape", "portrait"],
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    format: "jpeg",
    colorMode: "fullcolor",
  };

  it("lets a fresh report overrule a stale row", () => {
    /* The regression this pins: the device asks for its frame BEFORE it polls
     * /config, so a row still holding the previous mounting produced the first
     * frame of every boot in the wrong geometry. On a D1001 that frame was drawn
     * top-left and cut off below row 800, which looked like the content had
     * failed to load. */
    const { caps, changed } = mergeReportedCaps(stored, "1280x800;landscape;landscape,portrait");
    expect(changed).toBe(true);
    expect(resolveDisplayCaps(caps).orientation).toBe("landscape");
    expect([resolveDisplayCaps(caps).width, resolveDisplayCaps(caps).height]).toEqual([1280, 800]);
  });

  it("reports nothing new when the row already agrees", () => {
    const { changed } = mergeReportedCaps(stored, "800x1280;portrait;landscape,portrait");
    expect(changed).toBe(false);
  });

  it("keeps the row when no report arrives or it is unusable", () => {
    expect(mergeReportedCaps(stored, null)).toEqual({ caps: stored, changed: false });
    expect(mergeReportedCaps(stored, "garbage")).toEqual({ caps: stored, changed: false });
    expect(mergeReportedCaps(stored, "99999x1;landscape;landscape")).toEqual({
      caps: stored,
      changed: false,
    });
  });

  it("never lets a device overrule the operator's chosen mounting", () => {
    const { caps } = mergeReportedCaps(stored, "1280x800;landscape;landscape,portrait");
    expect(resolveDisplayCaps(caps, "portrait").orientation).toBe("portrait");
  });
});
