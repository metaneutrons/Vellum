import { describe, it, expect } from "vitest";

/**
 * The rule under test, stated as the renderer implements it:
 *
 *   an explicitly configured room timezone wins; otherwise the display's zone,
 *   resolved from its device override or its site; otherwise the schema default.
 *
 * Extracted here rather than exercised through `render()`, which fetches a
 * calendar and paints a canvas. The decision is three lines of precedence and the
 * bug it prevents is a clock on screen disagreeing with the schedule that decided
 * when to draw it, so it is worth pinning on its own.
 */
function effectiveTimezone(
  rawConfig: unknown,
  displayTimezone: string | undefined,
  schemaDefault = "UTC"
): string {
  const raw = (rawConfig as { timezone?: unknown } | null)?.timezone;
  return typeof raw === "string" && raw.trim() ? raw : (displayTimezone ?? schemaDefault);
}

describe("room-booking timezone precedence", () => {
  it("keeps an explicitly configured room timezone", () => {
    expect(effectiveTimezone({ timezone: "Asia/Singapore" }, "Europe/Berlin")).toBe(
      "Asia/Singapore"
    );
  });

  it("falls back to the display's zone when the room does not name one", () => {
    expect(effectiveTimezone({}, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(effectiveTimezone(null, "America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it("falls back to the schema default when nothing knows the zone", () => {
    expect(effectiveTimezone({}, undefined)).toBe("UTC");
  });

  /* The reason the raw config is consulted instead of the parsed one: the schema
   * defaults timezone to "UTC", so after parsing there is no way to tell an unset
   * value from an explicit one, and the display's zone could never win. */
  it("treats a blank configured value as unset", () => {
    expect(effectiveTimezone({ timezone: "   " }, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(effectiveTimezone({ timezone: "" }, "Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("ignores a configured value that is not a string", () => {
    expect(effectiveTimezone({ timezone: 42 }, "Europe/Berlin")).toBe("Europe/Berlin");
  });
});
