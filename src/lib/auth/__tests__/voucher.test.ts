// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateToken, type DeviceRepository, type DeviceRecord } from "@/lib/auth";

/** Build a mock DeviceRepository; override individual methods per test. */
function mockRepo(over: Partial<DeviceRepository> = {}): DeviceRepository {
  return {
    findByMac: vi.fn(async () => null),
    insertPending: vi.fn(async () => {}),
    updatePublicKey: vi.fn(async () => {}),
    updateDisplayCaps: vi.fn(async () => {}),
    updateApproved: vi.fn(async () => {}),
    updateLastSeen: vi.fn(async () => {}),
    claimVoucher: vi.fn(async () => false),
    upsertApprovedWithToken: vi.fn(async () => {}),
    ...over,
  };
}

const approved = (token: string): DeviceRecord => ({
  mac: "AA:BB:CC:DD:EE:FF",
  status: "approved",
  token,
  publicKey: null,
});

beforeEach(() => vi.clearAllMocks());

describe("validateToken — zero-touch voucher enrolment (additive path)", () => {
  it("enrols an unknown MAC that presents a valid, unclaimed voucher token", async () => {
    const repo = mockRepo({
      findByMac: vi.fn(async () => null), // unknown device
      claimVoucher: vi.fn(async () => true), // voucher claimed
    });
    const ok = await validateToken("11:22:33:44:55:66", "voucher-token", repo);
    expect(ok).toBe(true);
    expect(repo.claimVoucher).toHaveBeenCalledWith("voucher-token", "11:22:33:44:55:66");
    expect(repo.upsertApprovedWithToken).toHaveBeenCalledWith("11:22:33:44:55:66", "voucher-token");
  });

  it("rejects an unknown MAC whose token matches no voucher", async () => {
    const repo = mockRepo({
      findByMac: vi.fn(async () => null),
      claimVoucher: vi.fn(async () => false), // no unclaimed voucher
    });
    expect(await validateToken("11:22:33:44:55:66", "bogus", repo)).toBe(false);
    expect(repo.upsertApprovedWithToken).not.toHaveBeenCalled();
  });

  it("does NOT consult vouchers for an already-approved device (audited fast path)", async () => {
    const repo = mockRepo({ findByMac: vi.fn(async () => approved("real-token")) });
    expect(await validateToken("AA:BB:CC:DD:EE:FF", "real-token", repo)).toBe(true);
    expect(repo.claimVoucher).not.toHaveBeenCalled();
  });

  it("rejects an approved device presenting the wrong token (no voucher fallback)", async () => {
    const repo = mockRepo({ findByMac: vi.fn(async () => approved("real-token")) });
    expect(await validateToken("AA:BB:CC:DD:EE:FF", "wrong", repo)).toBe(false);
    expect(repo.claimVoucher).not.toHaveBeenCalled();
  });

  it("rejects a pending device and never reaches the voucher path", async () => {
    const repo = mockRepo({
      findByMac: vi.fn(async () => ({ mac: "x", status: "pending", token: null, publicKey: null })),
    });
    expect(await validateToken("x", "anything", repo)).toBe(false);
    expect(repo.claimVoucher).not.toHaveBeenCalled();
  });

  it("rejects an empty token before any lookup", async () => {
    const repo = mockRepo();
    expect(await validateToken("x", "", repo)).toBe(false);
    expect(repo.findByMac).not.toHaveBeenCalled();
  });
});
