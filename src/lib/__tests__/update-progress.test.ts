// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { updateProgressRows, type UpdateProgress } from "../update-progress";

const progress = (overrides: Partial<UpdateProgress>): UpdateProgress => ({
  phase: "verifying",
  detail: null,
  at: "2026-08-15T09:00:00Z",
  startedAt: "2026-08-15T09:00:00Z",
  ...overrides,
});

describe("server update progress rows", () => {
  it("advances every completed step and keeps the current one active", () => {
    expect(updateProgressRows(progress({ phase: "deploying" })).map((row) => row.state))
      .toEqual(["done", "done", "active", "pending"]);
  });

  it("keeps every step visible after successful completion", () => {
    expect(updateProgressRows(progress({ phase: "done" })).map((row) => row.state))
      .toEqual(["done", "done", "done", "done"]);
  });

  it("shows the failed step and a successful rollback", () => {
    expect(updateProgressRows(progress({ phase: "failed", failedPhase: "waiting-for-health",
      rollbackAttempted: true })).map((row) => [row.phase, row.state])).toEqual([
      ["verifying", "done"],
      ["backing-up", "done"],
      ["deploying", "done"],
      ["waiting-for-health", "failed"],
      ["rolling-back", "done"],
    ]);
  });

  it("distinguishes a rollback that is still running or itself failed", () => {
    expect(updateProgressRows(progress({ phase: "rolling-back", failedPhase: "deploying",
      rollbackAttempted: true })).at(-1)).toEqual({ phase: "rolling-back", state: "active" });
    expect(updateProgressRows(progress({ phase: "failed", failedPhase: "rolling-back",
      rollbackAttempted: true })).at(-1)).toEqual({ phase: "rolling-back", state: "failed" });
  });
});
