// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The fallback chain is the whole of this module, and every view depends on it
 * agreeing with every other view. A device that reads "Foyer" in the list and
 * "AA:BB:…" on its own page is worse than one with no name at all.
 */

import { describe, it, expect } from "vitest";
import { deviceName, hasOwnName } from "../device-name";

const MAC = "58E6C50F4054";

describe("deviceName", () => {
  it("prefers the name an operator gave it", () => {
    expect(deviceName({ label: "Foyer", mac: MAC }, "1J.1.18")).toBe("Foyer");
  });

  it("falls back to the content when there is no name", () => {
    expect(deviceName({ label: null, mac: MAC }, "1J.1.18")).toBe("1J.1.18");
  });

  it("falls back to the address when there is neither", () => {
    expect(deviceName({ label: null, mac: MAC })).toBe(MAC);
  });

  /* Whitespace is what an operator leaves behind when they clear the field, and a
   * sign called " " is indistinguishable from a bug. */
  it("treats a blank name as no name", () => {
    expect(deviceName({ label: "   ", mac: MAC }, "1J.1.18")).toBe("1J.1.18");
    expect(deviceName({ label: "", mac: MAC })).toBe(MAC);
  });

  it("trims what it returns", () => {
    expect(deviceName({ label: "  Foyer  ", mac: MAC })).toBe("Foyer");
    expect(deviceName({ label: null, mac: MAC }, "  1J.1.18 ")).toBe("1J.1.18");
  });

  it("skips a blank content name too", () => {
    expect(deviceName({ label: null, mac: MAC }, "  ")).toBe(MAC);
    expect(deviceName({ label: null, mac: MAC }, null)).toBe(MAC);
  });

  /* Never empty: every caller puts the result somewhere a person has to read. */
  it("always returns something", () => {
    for (const label of [null, "", "  ", "Foyer"]) {
      for (const content of [null, undefined, "", "1J.1.18"]) {
        expect(deviceName({ label, mac: MAC }, content).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("hasOwnName", () => {
  /* Views use this to decide between a monospace address and a proper name, so a
   * blank must not count: it would set three spaces in a name font. */
  it("is true only for a name a person chose", () => {
    expect(hasOwnName({ label: "Foyer" })).toBe(true);
    expect(hasOwnName({ label: "  " })).toBe(false);
    expect(hasOwnName({ label: "" })).toBe(false);
    expect(hasOwnName({ label: null })).toBe(false);
    expect(hasOwnName({})).toBe(false);
  });
});
