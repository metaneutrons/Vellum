// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { normalizeProvisioningMac, signUsbProvisioningAuthorization } from "../usb-authorization";

describe("USB provisioning authorization", () => {
  it("matches the firmware HMAC-SHA256 contract", () => {
    expect(
      signUsbProvisioningAuthorization({
        deviceToken: "01".repeat(32),
        mac: "a1b2c3d4e5f6",
        challenge: "00112233445566778899aabbccddeeff",
        payloadDigest: "ff".repeat(32),
      })
    ).toBe("41d18d94f82f33e13c680c62a1e73ccc4f86d7210896e8b644b5f225953bc053");
  });

  it("normalizes MACs and rejects malformed or ambiguous inputs", () => {
    expect(normalizeProvisioningMac(" a1b2c3d4e5f6 ")).toBe("A1B2C3D4E5F6");
    expect(() => normalizeProvisioningMac("A1:B2:C3:D4:E5:F6")).toThrow("invalid_device_mac");
    expect(() =>
      signUsbProvisioningAuthorization({
        deviceToken: "01".repeat(32),
        mac: "A1B2C3D4E5F6",
        challenge: "00",
        payloadDigest: "ff".repeat(32),
      })
    ).toThrow("invalid_usb_challenge");
  });
});
