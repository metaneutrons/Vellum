// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The two door-sign types are gone from the registry, and the condition that made
 * that safe is asserted here rather than remembered.
 *
 * The order was the whole point. Unregistering a slug while an instance still names
 * it makes `getContentRenderer` return undefined and the render route answer 500,
 * which on a wall is a display that quietly stops updating. So the types stayed
 * registered-but-deprecated until the estate held no instance of either: production
 * never had one, and development's single door sign became a two-seat name plate on
 * 2026-08-25.
 *
 * What this file now guards is the other direction. An unknown slug must fail in a
 * way an operator can act on, and the live types must stay creatable.
 */

import { describe, it, expect } from "vitest";
import { getContentRenderer, getAllContentRenderers } from "../registry";

const RETIRED = ["door-sign", "door-sign-multi"];

describe("retired content types", () => {
  it("are no longer registered", () => {
    for (const slug of RETIRED) {
      expect(getContentRenderer(slug), `${slug} must be gone`).toBeUndefined();
    }
  });

  /* The counterpart of removing them: nothing in the registry may claim to be
   * retired any more, because "deprecated" was the holding state and holding is
   * over. A type that reappears with the flag would sit in neither state. */
  it("leave nothing behind wearing the deprecated flag", () => {
    expect(getAllContentRenderers().filter((r) => r.deprecated)).toEqual([]);
  });

  it("leaves exactly the live types creatable", () => {
    expect(
      getAllContentRenderers()
        .map((r) => r.slug)
        .sort()
    ).toEqual(["name-plate", "room-booking"]);
  });

  /* Every registered type has both halves of the contract. Cheap, and it is the
   * assertion that would have caught a half-converted renderer during the load/draw
   * split. */
  it("gives every live type a load and a draw", () => {
    for (const renderer of getAllContentRenderers()) {
      expect(typeof renderer.load, `${renderer.slug}.load`).toBe("function");
      expect(typeof renderer.draw, `${renderer.slug}.draw`).toBe("function");
    }
  });
});
