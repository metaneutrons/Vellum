import { describe, expect, it } from "vitest";
import { assessSecurityPosture, isOtaCompatible, type SecurityEvidence } from "../security-posture";
import type { FirmwareBinary } from "../firmware";

const e1003: SecurityEvidence = {
  securityProfile: "development",
  nvsIntegrity: "disabled",
  chipModel: "esp32s3",
  flashSizeBytes: 8 * 1024 * 1024,
  partitionLayout: "e-series-v1",
  partitionFingerprint: "101a2283c446d81fc96980b159a6610ed308bc762a61756d03825f9d91476dc8",
  partitionTableOffset: 0x8000,
  layoutVerified: true,
  secureBootEnabled: false,
  flashEncryptionEnabled: false,
  nvsEncryptionEnabled: false,
};

const binary: FirmwareBinary = {
  url: "https://example.com/factory.bin",
  size: 1,
  otaUrl: "https://example.com/ota.bin",
  otaSha256: "b".repeat(64),
  otaSignature: "signature",
  otaSize: 1,
  partitionLayout: "e-series-v1",
  securityProfile: "development",
  requiresSecureBoot: false,
  requiresFlashEncryption: false,
};

describe("security posture", () => {
  it("verifies a canonical development layout", () => {
    expect(assessSecurityPosture(e1003, "e1003")).toEqual({
      state: "development",
      verified: true,
      reasons: [],
    });
  });

  it("rejects a profile claim contradicted by eFuse state", () => {
    const evidence = { ...e1003, securityProfile: "production" as const };
    const result = assessSecurityPosture(evidence, "e1003");
    expect(result.state).toBe("incompatible");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["secure_layout_required", "secure_boot_required"])
    );
  });

  it("accepts a fully consistent production S3 posture", () => {
    const evidence: SecurityEvidence = {
      ...e1003,
      securityProfile: "production",
      nvsIntegrity: "valid",
      partitionLayout: "e-series-secure-v1",
      partitionFingerprint: "b953b7b51a1fcaddb537ddb551aa8f4edcacf3c0dd13e9f8315e1017d84194b8",
      partitionTableOffset: 0x10000,
      secureBootEnabled: true,
      flashEncryptionEnabled: true,
      nvsEncryptionEnabled: true,
    };
    expect(assessSecurityPosture(evidence, "e1003").state).toBe("production");
  });

  it("blocks OTA partition transitions, including pinned versions", () => {
    expect(
      isOtaCompatible({ ...binary, partitionLayout: "e-series-secure-v1" }, "e1003", e1003)
    ).toEqual({
      compatible: false,
      reason: "partition_layout_transition_requires_full_flash",
    });
  });

  it("only bootstraps unattested legacy devices into reversible development images", () => {
    expect(isOtaCompatible(binary, "e1003", null).compatible).toBe(true);
    expect(
      isOtaCompatible(
        {
          ...binary,
          partitionLayout: "e-series-secure-v1",
          securityProfile: "production",
          requiresSecureBoot: true,
        },
        "e1003",
        null
      )
    ).toEqual({ compatible: false, reason: "attestation_required" });
  });

  it("rejects malformed and incomplete evidence", () => {
    expect(assessSecurityPosture({ ...e1003, partitionFingerprint: null }, "e1003")).toEqual({
      state: "unattested",
      verified: false,
      reasons: ["incomplete_evidence"],
    });
    expect(assessSecurityPosture({ ...e1003, chipModel: "esp32p4" }, "e1003").verified).toBe(false);
  });
});
