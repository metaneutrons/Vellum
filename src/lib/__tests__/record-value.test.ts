import { describe, expect, it } from "vitest";

import { asRecord, recordBoolean, recordNumber, recordString } from "@/lib/record-value";

describe("recordString", () => {
  it("returns text unchanged", () => {
    expect(recordString({ a: "x" }, "a", "fb")).toBe("x");
  });

  it("keeps an empty string rather than falling back", () => {
    expect(recordString({ a: "" }, "a", "fb")).toBe("");
  });

  it("falls back for a missing key", () => {
    expect(recordString({}, "a", "fb")).toBe("fb");
  });

  /* This is the case an `as string` assertion hides: the value is present and
   * wrong, so the assertion passes it straight into a text input. */
  it("falls back for a value of the wrong type", () => {
    expect(recordString({ a: 42 }, "a", "fb")).toBe("fb");
    expect(recordString({ a: null }, "a", "fb")).toBe("fb");
    expect(recordString({ a: { nested: true } }, "a", "fb")).toBe("fb");
  });
});

describe("recordNumber", () => {
  it("returns a finite number unchanged, zero included", () => {
    expect(recordNumber({ a: 120 }, "a", 900)).toBe(120);
    expect(recordNumber({ a: 0 }, "a", 900)).toBe(0);
    expect(recordNumber({ a: -1.5 }, "a", 900)).toBe(-1.5);
  });

  it("falls back for a missing key or a wrong type", () => {
    expect(recordNumber({}, "a", 900)).toBe(900);
    expect(recordNumber({ a: "120" }, "a", 900)).toBe(900);
  });

  it("treats NaN and Infinity as absent", () => {
    expect(recordNumber({ a: Number.NaN }, "a", 900)).toBe(900);
    expect(recordNumber({ a: Number.POSITIVE_INFINITY }, "a", 900)).toBe(900);
  });
});

describe("recordBoolean", () => {
  it("returns a boolean unchanged, false included", () => {
    expect(recordBoolean({ a: true }, "a", false)).toBe(true);
    expect(recordBoolean({ a: false }, "a", true)).toBe(false);
  });

  it("does not treat a truthy value as true", () => {
    expect(recordBoolean({ a: "yes" }, "a", false)).toBe(false);
    expect(recordBoolean({ a: 1 }, "a", false)).toBe(false);
  });

  it("falls back for a missing key", () => {
    expect(recordBoolean({}, "a", true)).toBe(true);
  });
});

describe("asRecord", () => {
  it("passes a plain object through", () => {
    const source = { a: 1 };
    expect(asRecord(source)).toBe(source);
  });

  it("answers with an empty record for anything else", () => {
    expect(asRecord(undefined)).toEqual({});
    expect(asRecord(null)).toEqual({});
    expect(asRecord("text")).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
  });
});
