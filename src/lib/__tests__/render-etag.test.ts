// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import { renderEntityTag } from "../render-etag";

describe("render entity tags", () => {
  it("is stable and fits the firmware response field", () => {
    const tag = renderEntityTag("idle", "idle-screen-v1:e1002:1.4.10");
    expect(tag).toBe(renderEntityTag("idle", "idle-screen-v1:e1002:1.4.10"));
    expect(tag.length).toBeLessThan(32);
    expect(tag).toMatch(/^"i-[0-9a-f]{16}"$/);
  });

  it("namespaces local idle states away from bitmap frames", () => {
    const payload = new Uint8Array([1, 2, 3]);
    expect(renderEntityTag("idle", payload)).not.toBe(renderEntityTag("frame", payload));
  });

  it("changes whenever the visible identity changes", () => {
    expect(renderEntityTag("idle", "e1002:1.4.10")).not.toBe(
      renderEntityTag("idle", "e1002:1.4.11")
    );
  });
});
