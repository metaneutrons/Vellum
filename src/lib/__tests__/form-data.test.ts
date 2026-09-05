// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The File branch is the whole reason these helpers exist, so it is the case
 * every test here is really about.
 */

import { describe, it, expect } from "vitest";
import { formString, formTrimmed, formStringOrNull } from "../form-data";

function withField(value: string | File): FormData {
  const form = new FormData();
  form.set("field", value);
  return form;
}

describe("formString", () => {
  it("returns text unchanged", () => {
    expect(formString(withField("hunter2"), "field")).toBe("hunter2");
  });

  it("returns empty for a missing field", () => {
    expect(formString(new FormData(), "field")).toBe("");
  });

  /* The defect this was written for: String(File) is "[object File]", which is
   * non-empty, survives a truthiness check, and is the same for everyone. */
  it("refuses a file rather than stringifying it", () => {
    const form = withField(new File(["x"], "payload.txt"));
    expect(formString(form, "field")).toBe("");
    expect(formString(form, "field")).not.toContain("object");
  });

  it("keeps an empty string as an empty string", () => {
    expect(formString(withField(""), "field")).toBe("");
  });
});

describe("formTrimmed", () => {
  it("trims", () => {
    expect(formTrimmed(withField("  Foyer  "), "field")).toBe("Foyer");
  });

  it("refuses a file here too", () => {
    expect(formTrimmed(withField(new File(["x"], "p.txt")), "field")).toBe("");
  });
});

describe("formStringOrNull", () => {
  /* The distinction formString cannot make: absent versus present-but-empty.
   * An optional field that clears a stored value depends on it. */
  it("separates absent from empty", () => {
    expect(formStringOrNull(new FormData(), "field")).toBeNull();
    expect(formStringOrNull(withField(""), "field")).toBe("");
  });

  it("treats a file as absent", () => {
    expect(formStringOrNull(withField(new File(["x"], "p.txt")), "field")).toBeNull();
  });
});
