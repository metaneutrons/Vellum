// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The simulator's address is duplicated nowhere else on purpose: the preview's
 * ordering depends on recognising it, and a second copy that drifted would put the
 * simulator's panel back in front of an operator without anything failing.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SIMULATOR_MAC, isSimulator } from "../simulator";

describe("isSimulator", () => {
  it("recognises the simulator whatever the case", () => {
    expect(isSimulator(SIMULATOR_MAC)).toBe(true);
    expect(isSimulator(SIMULATOR_MAC.toLowerCase())).toBe(true);
  });

  it("does not mistake a real display for it", () => {
    expect(isSimulator("58E6C50F4054")).toBe(false);
    expect(isSimulator("")).toBe(false);
  });
});

describe("the simulator's own address", () => {
  /* The simulator page is the one place that has to agree, and it is a client
   * component that cannot be imported here without a DOM. Reading its source is
   * blunt but it fails loudly, which is the point. */
  it("is the constant the simulator page uses", () => {
    const source = readFileSync("src/app/simulator/client.tsx", "utf8");
    expect(source).toContain("SIMULATOR_MAC");
    expect(source).not.toMatch(/mac:\s*"[0-9A-Fa-f]{12}"/);
  });
});
