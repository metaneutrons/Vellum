// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import {
  OTA_DOWNLOAD_TTL_SECONDS,
  createOtaDownloadUrl,
  signOtaDownloadGrant,
  verifyOtaDownloadGrant,
} from "../firmware-download";

const token = "device-token-with-enough-entropy";
const base = { mac: "AA:BB:CC:DD:EE:FF", tag: "firmware-v1.4.3", model: "e1003" };

describe("firmware download grants", () => {
  it("creates a short-lived Vellum URL without exposing the device token", () => {
    const url = new URL(createOtaDownloadUrl("https://vellum.example.com", base, token, 1_000));
    expect(url.origin).toBe("https://vellum.example.com");
    expect(url.pathname).toBe("/api/v1/ink/firmware");
    expect(url.searchParams.get("expires")).toBe(String(1_000 + OTA_DOWNLOAD_TTL_SECONDS));
    expect(url.href).not.toContain(token);

    const grant = {
      ...base,
      expires: Number(url.searchParams.get("expires")),
    };
    expect(verifyOtaDownloadGrant(grant, url.searchParams.get("signature") ?? "", token, 1_000)).toBe(true);
  });

  it("rejects expired, overlong and tampered grants", () => {
    const grant = { ...base, expires: 2_000 };
    const signature = signOtaDownloadGrant(grant, token);
    expect(verifyOtaDownloadGrant(grant, signature, token, 2_001)).toBe(false);
    expect(verifyOtaDownloadGrant({ ...grant, expires: 9_999 }, signature, token, 1_000)).toBe(false);
    expect(verifyOtaDownloadGrant({ ...grant, model: "d1001" }, signature, token, 1_500)).toBe(false);
    expect(verifyOtaDownloadGrant(grant, "not-a-signature", token, 1_500)).toBe(false);
  });
});
