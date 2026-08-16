// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it, vi } from "vitest";
import { FirmwareBinaryCache } from "../firmware-binary-cache";

const buffer = (...bytes: number[]) => new Uint8Array(bytes).buffer;

describe("FirmwareBinaryCache", () => {
  it("reuses an immutable image until its TTL expires", async () => {
    let now = 1_000;
    const cache = new FirmwareBinaryCache(100, 500, () => now);
    const load = vi.fn(async () => buffer(1, 2, 3));
    expect(await cache.get("release:model", 3, load)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await cache.get("release:model", 3, load)).toEqual(new Uint8Array([1, 2, 3]));
    expect(load).toHaveBeenCalledTimes(1);
    now += 501;
    await cache.get("release:model", 3, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent fleet downloads into one upstream request", async () => {
    const cache = new FirmwareBinaryCache(100, 500);
    let resolve!: (value: ArrayBuffer) => void;
    const load = vi.fn(
      () =>
        new Promise<ArrayBuffer>((done) => {
          resolve = done;
        })
    );
    const first = cache.get("release:model", 2, load);
    const second = cache.get("release:model", 2, load);
    resolve(buffer(4, 5));
    expect(await first).toEqual(new Uint8Array([4, 5]));
    expect(await second).toEqual(new Uint8Array([4, 5]));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated downloads and never caches them", async () => {
    const cache = new FirmwareBinaryCache(100, 500);
    const load = vi.fn(async () => buffer(1));
    await expect(cache.get("release:model", 2, load)).rejects.toThrow("firmware size mismatch");
    await expect(cache.get("release:model", 2, load)).rejects.toThrow("firmware size mismatch");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used image at its byte limit", async () => {
    let now = 1;
    const cache = new FirmwareBinaryCache(4, 1_000, () => now);
    await cache.get("a", 2, async () => buffer(1, 1));
    now += 1;
    await cache.get("b", 2, async () => buffer(2, 2));
    now += 1;
    await cache.get("a", 2, async () => buffer(9, 9)); // refresh a
    now += 1;
    await cache.get("c", 2, async () => buffer(3, 3)); // evicts b
    const reloadB = vi.fn(async () => buffer(4, 4));
    expect(await cache.get("b", 2, reloadB)).toEqual(new Uint8Array([4, 4]));
    expect(reloadB).toHaveBeenCalledOnce();
  });
});
