import { describe, it, expect } from "vitest";
import { resolveDeviceSettings, isUsableTimezone } from "../device-settings";

const PROFILE_A = "11111111-1111-1111-1111-111111111111";
const PROFILE_B = "22222222-2222-2222-2222-222222222222";
const THEME_SITE = "33333333-3333-3333-3333-333333333333";
const THEME_DEVICE = "44444444-4444-4444-4444-444444444444";

describe("resolveDeviceSettings", () => {
  it("resolves to nothing when no layer names anything", () => {
    const r = resolveDeviceSettings({});
    expect(r.values).toEqual({
      refreshProfileId: null,
      themeId: null,
      contentInstanceId: null,
      timezone: null,
    });
  });

  it("lets the device override the site, and the site override the workspace default", () => {
    const r = resolveDeviceSettings({
      workspace: { refreshProfileId: PROFILE_A, themeId: THEME_SITE },
      site: { refreshProfileId: PROFILE_B, timezone: "Europe/Berlin" },
      device: { themeId: THEME_DEVICE },
    });
    expect(r.values.refreshProfileId).toBe(PROFILE_B);
    expect(r.values.themeId).toBe(THEME_DEVICE);
    expect(r.values.timezone).toBe("Europe/Berlin");
    expect(r.from.refreshProfileId).toBe("site");
    expect(r.from.themeId).toBe("device");
    expect(r.from.timezone).toBe("site");
  });

  /* The decision this pins, and the one everything else depends on: devices.theme_id
   * is null for every display that never had a theme picked, which is most of them.
   * Treating that null as an explicit choice would make the device layer override
   * the site with emptiness, and a site default would never apply to anything. */
  it("treats a null in a layer as silence, not as an explicit none", () => {
    const r = resolveDeviceSettings({
      site: { themeId: THEME_SITE },
      device: { themeId: null, refreshProfileId: null },
    });
    expect(r.values.themeId).toBe(THEME_SITE);
    expect(r.from.themeId).toBe("site");
  });

  it("keeps the device's timezone when it disagrees with its site", () => {
    const r = resolveDeviceSettings({
      site: { timezone: "Europe/Berlin" },
      device: { timezone: "America/Los_Angeles" },
    });
    expect(r.values.timezone).toBe("America/Los_Angeles");
    expect(r.from.timezone).toBe("device");
  });

  it("reports the workspace default as the source when nothing more specific applies", () => {
    const r = resolveDeviceSettings({ workspace: { themeId: THEME_SITE } });
    expect(r.values.themeId).toBe(THEME_SITE);
    expect(r.from.themeId).toBe("builtin");
  });

  /* A display on a bench belongs to no site, and that has to keep working: the
   * whole staged delivery depends on a siteless device behaving exactly as before. */
  it("works for a device with no site at all", () => {
    const r = resolveDeviceSettings({
      workspace: { refreshProfileId: PROFILE_A },
      site: null,
      device: { themeId: THEME_DEVICE },
    });
    expect(r.values.refreshProfileId).toBe(PROFILE_A);
    expect(r.values.themeId).toBe(THEME_DEVICE);
    expect(r.values.timezone).toBeNull();
  });
});

describe("isUsableTimezone", () => {
  it("accepts zones this runtime can resolve", () => {
    expect(isUsableTimezone("Europe/Berlin")).toBe(true);
    expect(isUsableTimezone("America/Los_Angeles")).toBe(true);
    expect(isUsableTimezone("UTC")).toBe(true);
  });

  /* Checked against the runtime rather than a regex: a zone that parses but has no
   * tzdata entry would fail at the moment a schedule is evaluated, which is on a
   * device in the field rather than in the form that accepted it. */
  it("rejects anything the runtime cannot resolve", () => {
    expect(isUsableTimezone("Europe/Atlantis")).toBe(false);
    expect(isUsableTimezone("")).toBe(false);
    expect(isUsableTimezone("Berlin")).toBe(false);
  });
});
