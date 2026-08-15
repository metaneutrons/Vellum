// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

process.env.VELLUM_UPDATER_TEST = "true";
process.env.UPDATER_TOKEN = "a".repeat(64);
const { equalToken, newer, reached, publicStatus, releaseDecision, stableServerReleaseTag, validateConfig, zonedClock } = await import("./control.mjs");

test("compares semantic release versions without allowing downgrades", () => {
  assert.equal(newer("1.8.1", "v1.8.2"), true);
  assert.equal(newer("v1.9.9", "v2.0.0"), true);
  assert.equal(newer("v2.0.0", "v1.99.99"), false);
  assert.equal(newer("v1.8.2", "v1.8.2"), false);
  assert.equal(newer("dev", "v1.8.2"), true);
  assert.equal(newer("v1.8.2", "firmware-v1.3.2"), false);
});

test("confirms an update only from the version actually running", () => {
  assert.equal(reached("v1.10.5", "v1.10.5"), true);
  assert.equal(reached("v1.10.6", "v1.10.5"), true);
  assert.equal(reached("v1.10.4", "v1.10.5"), false);
  assert.equal(reached(null, "v1.10.5"), false);
});

test("does not offer a release until every signed container artifact is ready", () => {
  assert.deepEqual(releaseDecision("v1.10.3", "v1.10.4", false),
    { state: "preparing", updateAvailable: false });
  assert.deepEqual(releaseDecision("v1.10.3", "v1.10.4", true),
    { state: "available", updateAvailable: true });
  assert.deepEqual(releaseDecision("v1.10.4", "v1.10.4", false),
    { state: "current", updateAvailable: false });
});

test("requires an exact control token", () => {
  assert.equal(equalToken("a".repeat(64)), true);
  assert.equal(equalToken("a".repeat(63)), false);
  assert.equal(equalToken("b".repeat(64)), false);
});

test("validates and evaluates timezone-aware maintenance schedules", () => {
  assert.equal(validateConfig({ mode: "automatic", maintenanceTime: "02:30", timezone: "Europe/Berlin" }), true);
  assert.equal(validateConfig({ mode: "manual", maintenanceTime: "23:59", timezone: "UTC" }), true);
  assert.equal(validateConfig({ mode: "automatic", maintenanceTime: "24:00", timezone: "UTC" }), false);
  assert.equal(validateConfig({ mode: "automatic", maintenanceTime: "02:30", timezone: "Not/AZone" }), false);
  assert.deepEqual(zonedClock(new Date("2026-08-11T00:30:00Z"), "Europe/Berlin"),
    { date: "2026-08-11", time: "02:30" });
});

test("reports its own image version so a stale updater is visible", () => {
  const status = publicStatus();
  // Built without the ARG in tests, so the field exists but is null — exactly
  // what an older updater looks like to the server, which must tolerate it.
  assert.ok("updaterVersion" in status, "status must always carry updaterVersion");
  assert.ok("updaterUpdateAvailable" in status, "status must always carry updaterUpdateAvailable");
  assert.equal(status.updaterSelfUpdateCapable, true);
  assert.equal(status.updaterSelfUpdateEnabled, true);
  assert.equal(status.updaterUpdateAvailable, false, "must not claim an update before a check ran");
});

test("treats an unknown own version as older than any release", () => {
  // A build without a baked version must still be reported as behind rather
  // than silently current.
  assert.equal(newer(null, "v1.9.6"), true);
  assert.equal(newer("0.0.0-dev", "v1.9.6"), true);
  assert.equal(newer("v1.9.6", "v1.9.6"), false);
  assert.equal(newer("v1.9.7", "v1.9.6"), false);
});

test("selects the newest stable server release without being masked by firmware", () => {
  assert.equal(stableServerReleaseTag([
    { tag_name: "firmware-v1.4.2", draft: false, prerelease: false },
    { tag_name: "v1.10.1", draft: false, prerelease: false },
    { tag_name: "v1.10.2", draft: false, prerelease: false },
    { tag_name: "v2.0.0", draft: false, prerelease: true },
    { tag_name: "v9.0.0", draft: true, prerelease: false },
  ]), "v1.10.2");
  assert.equal(stableServerReleaseTag([
    { tag_name: "firmware-v1.4.2", draft: false, prerelease: false },
  ]), null);
  // Keep custom RELEASE_API endpoints pointing at one release compatible.
  assert.equal(stableServerReleaseTag({ tag_name: "v1.10.2", draft: false, prerelease: false }), "v1.10.2");
});
