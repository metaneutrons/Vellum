import { describe, it, expect } from "vitest";
import { cascade, explainKey, type Layer } from "../cascade";

interface Policy {
  intervalS: number;
  brightness: number;
  schedule: string[];
}

const base: Policy = { intervalS: 900, brightness: 80, schedule: [] };

describe("cascade", () => {
  it("takes the built-in values when no layer says otherwise", () => {
    const r = cascade(base, []);
    expect(r.values).toEqual(base);
    expect(r.from.intervalS).toBe("builtin");
  });

  it("lets a more specific layer win over a more general one", () => {
    const layers: Layer<Policy>[] = [
      { name: "site", values: { intervalS: 600, brightness: 60 } },
      { name: "profile", values: { intervalS: 300 } },
      { name: "device", values: { brightness: 10 } },
    ];
    const r = cascade(base, layers);
    expect(r.values.intervalS).toBe(300);
    expect(r.values.brightness).toBe(10);
    expect(r.from.intervalS).toBe("profile");
    expect(r.from.brightness).toBe("device");
  });

  /* The property that makes partial schemas mandatory: a layer that stays silent
   * about a setting must leave it alone. A full parse would fill every absent key
   * with its default and reset what it never mentioned. */
  it("leaves a setting alone when a layer does not mention it", () => {
    const r = cascade(base, [
      { name: "profile", values: { intervalS: 60 } },
      { name: "device", values: { brightness: undefined } },
    ]);
    expect(r.values.brightness).toBe(80);
    expect(r.from.brightness).toBe("builtin");
  });

  it("ignores a layer with no values at all", () => {
    const r = cascade(base, [
      { name: "site", values: null },
      { name: "profile", values: undefined },
    ]);
    expect(r.values).toEqual(base);
  });

  /* Arrays replace wholesale. "Does a site's schedule extend the profile's or
   * replace it?" has no answer an operator can predict, and replacement is the
   * rule that fits in one sentence. */
  it("replaces an array rather than merging it element-wise", () => {
    const r = cascade({ ...base, schedule: ["night"] }, [
      { name: "profile", values: { schedule: ["weekend", "holiday"] } },
    ]);
    expect(r.values.schedule).toEqual(["weekend", "holiday"]);
  });

  /* Order comes from LAYER_ORDER, not from the array the caller happens to pass:
   * a caller that lists device before site must still get device winning. */
  it("applies layers in cascade order regardless of argument order", () => {
    const r = cascade(base, [
      { name: "device", values: { intervalS: 30 } },
      { name: "profile", values: { intervalS: 300 } },
      { name: "site", values: { intervalS: 600 } },
    ]);
    expect(r.values.intervalS).toBe(30);
    expect(r.from.intervalS).toBe("device");
  });

  it("explains where a value came from", () => {
    const r = cascade(base, [{ name: "profile", values: { brightness: 25 } }]);
    expect(explainKey(r, "brightness")).toBe("brightness=25 (profile)");
    expect(explainKey(r, "intervalS")).toBe("intervalS=900 (builtin)");
  });
});
