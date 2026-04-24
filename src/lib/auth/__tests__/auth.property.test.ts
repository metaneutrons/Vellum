import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  handleHello,
  approveDevice,
  validateToken,
  type DeviceRecord,
  type DeviceRepository,
} from "../index";

// --- In-memory repository for testing ---

function createInMemoryRepo(): DeviceRepository & {
  store: Map<string, DeviceRecord>;
} {
  const store = new Map<string, DeviceRecord>();
  return {
    store,
    async findByMac(mac) {
      return store.get(mac) ?? null;
    },
    async insertPending(mac, publicKey) {
      store.set(mac, { mac, status: "pending", token: null, publicKey: publicKey ?? null });
    },
    async updatePublicKey(mac, publicKey) {
      const d = store.get(mac);
      if (d) d.publicKey = publicKey;
    },
    async updateDisplayCaps() {
      // no-op for tests
    },
    async updateApproved(mac, token) {
      const d = store.get(mac);
      if (d) {
        d.status = "approved";
        d.token = token;
      }
    },
    async updateLastSeen(_mac) {
      // no-op for tests
    },
  };
}

// --- Generator: valid MAC addresses ---

const arbMac = fc
  .stringMatching(/^[0-9A-F]{12}$/)
  .map((s) => s.match(/.{2}/g)!.join(":"));

/**
 * Property 10: Unknown MAC registration creates pending device
 * Validates: Requirements 3.2
 *
 * For any valid MAC address not already in the device registry,
 * calling handleHello(mac) should create a device record with
 * status "pending" and return a response indicating pending status.
 */
describe("Property 10: Unknown MAC registration creates pending device", () => {
  it("handleHello with unknown MAC creates pending device and returns pending status", async () => {
    await fc.assert(
      fc.asyncProperty(arbMac, async (mac) => {
        const repo = createInMemoryRepo();

        const result = await handleHello(mac, null, undefined, repo);

        expect(result.status).toBe("pending");
        expect(result.token).toBeUndefined();

        const stored = repo.store.get(mac);
        expect(stored).toBeDefined();
        expect(stored!.status).toBe("pending");
        expect(stored!.token).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 11: Approved device receives token on next hello
 * Validates: Requirements 3.3
 *
 * For any device in "pending" status, after calling approveDevice(mac),
 * the next call to handleHello(mac) should return a non-empty
 * cryptographic token, and the device record should have status
 * "approved" with a non-null token.
 */
describe("Property 11: Approved device receives token on next hello", () => {
  it("after approveDevice, handleHello returns a 64-char hex token", async () => {
    await fc.assert(
      fc.asyncProperty(arbMac, async (mac) => {
        const repo = createInMemoryRepo();

        // Register device
        await handleHello(mac, null, undefined, repo);
        expect(repo.store.get(mac)!.status).toBe("pending");

        // Approve
        await approveDevice(mac, repo);
        const approved = repo.store.get(mac)!;
        expect(approved.status).toBe("approved");
        expect(approved.token).not.toBeNull();
        expect(approved.token).toHaveLength(64); // 32 bytes hex

        // Next hello should return the token
        const result = await handleHello(mac, null, undefined, repo);
        expect(result.status).toBe("approved");
        expect(result.token).toBe(approved.token);
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 12: Invalid or missing token returns 401
 * Validates: Requirements 3.6
 *
 * For any render request where the token is missing, empty, or does
 * not match any approved device's token, validateToken should return false.
 */
describe("Property 12: Invalid or missing token returns 401", () => {
  it("validateToken rejects empty token", async () => {
    await fc.assert(
      fc.asyncProperty(arbMac, async (mac) => {
        const repo = createInMemoryRepo();
        await handleHello(mac, null, undefined, repo);
        await approveDevice(mac, repo);

        const valid = await validateToken(mac, "", repo);
        expect(valid).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("validateToken rejects wrong token for approved device", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMac,
        fc.stringMatching(/^[0-9a-f]{64}$/),
        async (mac, fakeToken) => {
          const repo = createInMemoryRepo();
          await handleHello(mac, null, undefined, repo);
          await approveDevice(mac, repo);

          const realToken = repo.store.get(mac)!.token!;
          // Only test when fakeToken differs from the real one
          fc.pre(fakeToken !== realToken);

          const valid = await validateToken(mac, fakeToken, repo);
          expect(valid).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("validateToken rejects unknown MAC", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMac,
        fc.stringMatching(/^[0-9a-f]{64}$/),
        async (mac, token) => {
          const repo = createInMemoryRepo();
          // Don't register the device at all
          const valid = await validateToken(mac, token, repo);
          expect(valid).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("validateToken rejects pending device even with a token string", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMac,
        fc.stringMatching(/^[0-9a-f]{64}$/),
        async (mac, token) => {
          const repo = createInMemoryRepo();
          await handleHello(mac, null, undefined, repo);
          // Device is pending, not approved

          const valid = await validateToken(mac, token, repo);
          expect(valid).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("validateToken accepts correct token for approved device", async () => {
    await fc.assert(
      fc.asyncProperty(arbMac, async (mac) => {
        const repo = createInMemoryRepo();
        await handleHello(mac, null, undefined, repo);
        await approveDevice(mac, repo);

        const realToken = repo.store.get(mac)!.token!;
        const valid = await validateToken(mac, realToken, repo);
        expect(valid).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
