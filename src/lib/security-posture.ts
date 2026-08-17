// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import type { FirmwareBinary } from "./firmware";

export type PartitionLayout = "e-series-v1" | "e-series-secure-v1" | "d1001-v1" | "unknown";
export type SecurityProfile = "development" | "testsecure" | "secureboot" | "production";

export interface SecurityEvidence {
  securityProfile: SecurityProfile | null;
  nvsIntegrity: "disabled" | "valid" | "invalid" | null;
  chipModel: "esp32s3" | "esp32p4" | "unknown" | null;
  flashSizeBytes: number | null;
  partitionLayout: PartitionLayout | null;
  partitionFingerprint: string | null;
  partitionTableOffset: number | null;
  layoutVerified: boolean | null;
  secureBootEnabled: boolean | null;
  flashEncryptionEnabled: boolean | null;
  nvsEncryptionEnabled: boolean | null;
}

export type SecurityPostureState =
  "unattested" | "incompatible" | "development" | "testsecure" | "secureboot" | "production";

export interface SecurityPostureAssessment {
  state: SecurityPostureState;
  verified: boolean;
  reasons: string[];
}

const MODELS = new Set(["e1001", "e1002", "e1003", "d1001"]);
const LAYOUT_FINGERPRINTS: Readonly<Record<Exclude<PartitionLayout, "unknown">, string>> = {
  "e-series-v1": "101a2283c446d81fc96980b159a6610ed308bc762a61756d03825f9d91476dc8",
  "e-series-secure-v1": "b953b7b51a1fcaddb537ddb551aa8f4edcacf3c0dd13e9f8315e1017d84194b8",
  "d1001-v1": "7ef2f49322b0e91bc13ff4c371a2466280476ba88a3c97de0bd60d20818cc5a8",
};

export function expectedLayoutForModel(model: string): PartitionLayout | null {
  if (model === "d1001") return "d1001-v1";
  return model.startsWith("e100") ? "e-series-v1" : null;
}

function evidenceComplete(e: SecurityEvidence): boolean {
  return (
    e.chipModel !== null &&
    e.flashSizeBytes !== null &&
    e.partitionLayout !== null &&
    e.partitionFingerprint !== null &&
    e.partitionTableOffset !== null &&
    e.layoutVerified !== null &&
    e.secureBootEnabled !== null &&
    e.flashEncryptionEnabled !== null &&
    e.nvsEncryptionEnabled !== null
  );
}

/**
 * Classify independently observed runtime evidence. Compile-time profile names
 * are treated as intent only; they can never override contradictory hardware.
 * Before Secure Boot is enabled this remains authenticated firmware telemetry,
 * not a hardware-rooted remote attestation.
 */
export function assessSecurityPosture(
  evidence: SecurityEvidence,
  model: string
): SecurityPostureAssessment {
  if (!MODELS.has(model) || !evidenceComplete(evidence)) {
    return { state: "unattested", verified: false, reasons: ["incomplete_evidence"] };
  }

  const reasons: string[] = [];
  const expectedChip = model === "d1001" ? "esp32p4" : "esp32s3";
  const normalLayout = expectedLayoutForModel(model);
  if (!normalLayout) {
    return { state: "unattested", verified: false, reasons: ["unknown_model"] };
  }
  const allowedLayout =
    expectedChip === "esp32s3"
      ? evidence.partitionLayout === normalLayout ||
        evidence.partitionLayout === "e-series-secure-v1"
      : evidence.partitionLayout === normalLayout;
  if (evidence.chipModel !== expectedChip) reasons.push("chip_model_mismatch");
  if (!allowedLayout || evidence.layoutVerified !== true) reasons.push("partition_layout_mismatch");
  const expectedFingerprint =
    evidence.partitionLayout && evidence.partitionLayout !== "unknown"
      ? LAYOUT_FINGERPRINTS[evidence.partitionLayout]
      : null;
  if (!expectedFingerprint || evidence.partitionFingerprint !== expectedFingerprint) {
    reasons.push("partition_fingerprint_mismatch");
  }
  const expectedOffset = evidence.partitionLayout === "e-series-secure-v1" ? 0x10000 : 0x8000;
  if (evidence.partitionTableOffset !== expectedOffset) reasons.push("partition_offset_mismatch");
  const minimumFlash = model === "d1001" ? 32 * 1024 * 1024 : 8 * 1024 * 1024;
  if ((evidence.flashSizeBytes ?? 0) < minimumFlash) reasons.push("flash_size_mismatch");

  const profile = evidence.securityProfile;
  if (profile === "production") {
    if (evidence.partitionLayout !== "e-series-secure-v1") reasons.push("secure_layout_required");
    if (evidence.secureBootEnabled !== true) reasons.push("secure_boot_required");
    if (evidence.flashEncryptionEnabled !== true) reasons.push("flash_encryption_required");
    if (evidence.nvsEncryptionEnabled !== true) reasons.push("nvs_encryption_required");
    if (evidence.nvsIntegrity !== "valid") reasons.push("nvs_integrity_required");
  } else if (profile === "secureboot") {
    if (evidence.partitionLayout !== "e-series-secure-v1") reasons.push("secure_layout_required");
    if (evidence.secureBootEnabled !== true) reasons.push("secure_boot_required");
  } else if (profile === "testsecure") {
    if (evidence.partitionLayout !== normalLayout) reasons.push("normal_layout_required");
    if (evidence.secureBootEnabled !== false) reasons.push("secure_boot_must_be_disabled");
    if (evidence.flashEncryptionEnabled !== false)
      reasons.push("flash_encryption_must_be_disabled");
    if (evidence.nvsIntegrity !== "valid") reasons.push("nvs_integrity_required");
  } else if (profile === "development") {
    if (evidence.partitionLayout !== normalLayout) reasons.push("normal_layout_required");
    if (evidence.secureBootEnabled !== false) reasons.push("secure_boot_profile_mismatch");
    if (evidence.flashEncryptionEnabled !== false)
      reasons.push("flash_encryption_profile_mismatch");
  } else {
    reasons.push("security_profile_missing");
  }

  if (reasons.length > 0) return { state: "incompatible", verified: false, reasons };
  if (!profile)
    return { state: "incompatible", verified: false, reasons: ["security_profile_missing"] };
  return { state: profile, verified: true, reasons: [] };
}

export function isOtaCompatible(
  binary: FirmwareBinary,
  model: string,
  evidence: SecurityEvidence | null
): { compatible: boolean; reason: string | null } {
  const targetLayout = binary.partitionLayout ?? expectedLayoutForModel(model);
  const targetProfile = binary.securityProfile ?? "development";
  if (!targetLayout) return { compatible: false, reason: "unknown_model" };

  // Migration bridge for pre-attestation firmware: only a reversible normal
  // development image is allowed. Secure layouts and irreversible eFuse
  // requirements always require complete, consistent runtime evidence.
  if (!evidence || !evidenceComplete(evidence)) {
    const bootstrap =
      targetProfile === "development" &&
      targetLayout === expectedLayoutForModel(model) &&
      binary.requiresSecureBoot !== true &&
      binary.requiresFlashEncryption !== true;
    return { compatible: bootstrap, reason: bootstrap ? null : "attestation_required" };
  }

  const current = assessSecurityPosture(evidence, model);
  if (!current.verified) return { compatible: false, reason: current.reasons[0] ?? "incompatible" };
  if (evidence.partitionLayout !== targetLayout) {
    return { compatible: false, reason: "partition_layout_transition_requires_full_flash" };
  }
  if (binary.requiresSecureBoot && evidence.secureBootEnabled !== true) {
    return { compatible: false, reason: "secure_boot_required" };
  }
  if (binary.requiresFlashEncryption && evidence.flashEncryptionEnabled !== true) {
    return { compatible: false, reason: "flash_encryption_required" };
  }
  return { compatible: true, reason: null };
}
