// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

process.env.VELLUM_UPDATER_TEST = "true";
process.env.UPDATER_TOKEN = "a".repeat(64);
const { equalToken, newer, validateConfig, zonedClock } = await import("./control.mjs");

test("compares semantic release versions without allowing downgrades", () => {
  assert.equal(newer("1.8.1", "v1.8.2"), true);
  assert.equal(newer("v1.9.9", "v2.0.0"), true);
  assert.equal(newer("v2.0.0", "v1.99.99"), false);
  assert.equal(newer("v1.8.2", "v1.8.2"), false);
  assert.equal(newer("dev", "v1.8.2"), true);
  assert.equal(newer("v1.8.2", "firmware-v1.3.2"), false);
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
