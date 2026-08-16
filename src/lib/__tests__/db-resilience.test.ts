// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it, vi } from "vitest";
import { DbResilienceManager } from "@/lib/db-resilience";

vi.mock("@/lib/logger", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

function postgresError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe("database retry safety", () => {
  it("never replays a write with an ambiguous connection outcome", async () => {
    const manager = new DbResilienceManager();
    let attempts = 0;

    await expect(
      manager.execute(
        async () => {
          attempts++;
          throw postgresError("08006");
        },
        "ambiguous-write",
        "write"
      )
    ).rejects.toThrow("08006");

    expect(attempts).toBe(1);
  });

  it("never replays a transaction after an ambiguous connection loss", async () => {
    const manager = new DbResilienceManager();
    let attempts = 0;

    await expect(
      manager.execute(
        async () => {
          attempts++;
          throw postgresError("08006");
        },
        "ambiguous-transaction",
        "transaction"
      )
    ).rejects.toThrow("08006");

    expect(attempts).toBe(1);
  });

  it("retries a transaction only after a guaranteed PostgreSQL rollback", async () => {
    const manager = new DbResilienceManager();
    let attempts = 0;

    const result = await manager.execute(
      async () => {
        attempts++;
        if (attempts === 1) throw postgresError("40001");
        return "committed";
      },
      "serializable-transaction",
      "transaction"
    );

    expect(result).toBe("committed");
    expect(attempts).toBe(2);
  });
});
