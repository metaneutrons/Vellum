// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * A retired content type still RENDERS and can no longer be CREATED.
 *
 * Both halves matter and they pull in opposite directions, which is why they are
 * asserted rather than described. Dropping a renderer outright would be a breaking
 * change for any instance still naming it: `getContentRenderer` returns undefined,
 * the render route answers 500, and on a wall that is a display which quietly stops
 * updating. Meanwhile a type that stays creatable is not retired at all.
 */

import { describe, it, expect } from "vitest";
import { getContentRenderer, getAllContentRenderers } from "../registry";

const RETIRED = ["door-sign", "door-sign-multi"];

describe("retired content types", () => {
  it("are still registered, so existing instances keep rendering", () => {
    for (const slug of RETIRED) {
      const renderer = getContentRenderer(slug);
      expect(renderer, `${slug} must stay registered`).toBeDefined();
      expect(typeof renderer?.load, `${slug} must still fetch`).toBe("function");
      expect(typeof renderer?.draw, `${slug} must still paint`).toBe("function");
    }
  });

  it("are marked, so the create path can refuse them", () => {
    for (const slug of RETIRED) {
      expect(getContentRenderer(slug)?.deprecated).toBe(true);
    }
  });

  /* The live types carry no flag. Without this, marking one by accident would take
   * it out of the menu silently and nobody would notice until someone tried to add
   * a room-booking display. */
  it("leaves every live type creatable", () => {
    const live = getAllContentRenderers().filter((r) => !r.deprecated);
    expect(live.map((r) => r.slug).sort()).toEqual(["name-plate", "room-booking"]);
  });
});
