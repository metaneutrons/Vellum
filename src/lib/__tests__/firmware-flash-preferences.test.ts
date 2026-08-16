// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import { resolveFlashModel } from "../firmware-flash-preferences";

describe("resolveFlashModel", () => {
  const models = ["e1001", "e1002", "d1001"] as const;

  it("restores a model that is still available", () => {
    expect(resolveFlashModel("d1001", models)).toBe("d1001");
  });

  it.each([null, "", "retired-model"])("falls back to the first registry item for %s", (stored) => {
    expect(resolveFlashModel(stored, models)).toBe("e1001");
  });

  it("handles an empty registry defensively", () => {
    expect(resolveFlashModel("d1001", [])).toBe("");
  });
});
