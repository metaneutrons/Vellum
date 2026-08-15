// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

export const FIRMWARE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FIRMWARE_CACHE_MAX_BYTES = 128 * 1024 * 1024;

interface CacheEntry {
  bytes: Uint8Array;
  expiresAt: number;
  lastAccess: number;
}

/** Bounded process-local cache for immutable signed OTA assets. It also
 * coalesces concurrent misses so a fleet rollout cannot stampede GitHub. */
export class FirmwareBinaryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes = FIRMWARE_CACHE_MAX_BYTES,
    private readonly ttlMs = FIRMWARE_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    this.totalBytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.totalBytes -= entry.bytes.byteLength;
    this.entries.delete(key);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  private makeRoom(size: number): void {
    this.prune();
    while (this.totalBytes + size > this.maxBytes && this.entries.size > 0) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccess < oldestAccess) {
          oldestKey = key;
          oldestAccess = entry.lastAccess;
        }
      }
      if (oldestKey === null) break;
      this.remove(oldestKey);
    }
  }

  async get(key: string, expectedSize: number, load: () => Promise<ArrayBuffer>): Promise<Uint8Array> {
    const cached = this.entries.get(key);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      cached.lastAccess = now;
      return cached.bytes.slice();
    }
    if (cached) this.remove(key);

    const existing = this.inflight.get(key);
    if (existing) return (await existing).slice();

    const pending = (async () => {
      const bytes = new Uint8Array(await load());
      if (bytes.byteLength !== expectedSize) {
        throw new Error(`firmware size mismatch: expected ${expectedSize}, received ${bytes.byteLength}`);
      }
      // Oversized images are still served, just never retained at the expense
      // of evicting the whole useful cache.
      if (bytes.byteLength <= this.maxBytes) {
        this.makeRoom(bytes.byteLength);
        this.entries.set(key, {
          bytes,
          expiresAt: this.now() + this.ttlMs,
          lastAccess: this.now(),
        });
        this.totalBytes += bytes.byteLength;
      }
      return bytes;
    })();
    this.inflight.set(key, pending);
    try {
      return (await pending).slice();
    } finally {
      this.inflight.delete(key);
    }
  }
}

export const firmwareBinaryCache = new FirmwareBinaryCache();
