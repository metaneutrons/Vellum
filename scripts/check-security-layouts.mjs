// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const definitions = [
  ["e-series-v1", "E_SERIES_V1", "firmware/partitions.csv"],
  ["e-series-secure-v1", "E_SERIES_SECURE_V1", "firmware/partitions.secure.csv"],
  ["d1001-v1", "D1001_V1", "firmware/partitions.d1001.csv"],
];
const typeValues = { app: 0, data: 1 };
const subtypeValues = {
  nvs: 0x02,
  nvs_keys: 0x04,
  ota: 0x00,
  phy: 0x01,
  ota_0: 0x10,
  ota_1: 0x11,
  fat: 0x81,
};
const typeEnums = { app: "ESP_PARTITION_TYPE_APP", data: "ESP_PARTITION_TYPE_DATA" };
const subtypeEnums = {
  nvs: "ESP_PARTITION_SUBTYPE_DATA_NVS",
  nvs_keys: "ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS",
  ota: "ESP_PARTITION_SUBTYPE_DATA_OTA",
  phy: "ESP_PARTITION_SUBTYPE_DATA_PHY",
  ota_0: "ESP_PARTITION_SUBTYPE_APP_OTA_0",
  ota_1: "ESP_PARTITION_SUBTYPE_APP_OTA_1",
  fat: "ESP_PARTITION_SUBTYPE_DATA_FAT",
};

function partitions(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [label, type, subtype, offset, size] = line.split(",").map((part) => part.trim());
      if (!(type in typeValues) || !(subtype in subtypeValues)) {
        throw new Error(`${path}: unsupported partition type ${type}/${subtype}`);
      }
      return { label, type, subtype, offset: Number(offset), size: Number(size) };
    });
}

function fingerprint(entries) {
  const hash = createHash("sha256").update("vellum-partition-layout-v1\0");
  for (const entry of entries) {
    hash.update(`${entry.label}\0`);
    const numeric = Buffer.alloc(10);
    numeric[0] = typeValues[entry.type];
    numeric[1] = subtypeValues[entry.subtype];
    numeric.writeUInt32BE(entry.offset, 2);
    numeric.writeUInt32BE(entry.size, 6);
    hash.update(numeric);
  }
  return hash.digest("hex");
}

const firmware = readFileSync("firmware/components/security_posture/security_posture.c", "utf8");
const server = readFileSync("src/lib/security-posture.ts", "utf8");
const failures = [];

for (const [layout, cName, path] of definitions) {
  const entries = partitions(path);
  const digest = fingerprint(entries);
  if (!server.includes(`"${layout}": "${digest}"`)) {
    failures.push(`${layout}: server fingerprint does not match ${path} (${digest})`);
  }
  const block = firmware.match(
    new RegExp(`static const expected_partition_t ${cName}\\[\\] = \\{([\\s\\S]*?)\\n\\};`)
  )?.[1];
  if (!block) {
    failures.push(`${layout}: firmware canonical layout array is missing`);
    continue;
  }
  for (const entry of entries) {
    const expected = `{\"${entry.label}\", ${typeEnums[entry.type]}, ${subtypeEnums[entry.subtype]}, 0x${entry.offset.toString(16)}, 0x${entry.size.toString(16)}}`;
    if (!block.replaceAll(/\s+/g, " ").includes(expected)) {
      failures.push(`${layout}: firmware entry differs from ${path}: ${entry.label}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log("Security layout definitions and fingerprints are synchronized.");
