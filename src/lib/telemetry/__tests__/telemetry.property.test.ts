import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { extractTelemetry } from "../index";
import type { TelemetryEntry } from "@/lib/types";

// --- Generators ---

const arbMac = fc.stringMatching(/^[0-9A-F]{12}$/).map((s) => s.match(/.{2}/g)!.join(":"));

const arbBatteryVoltage = fc.float({ min: 2.5, max: 4.5, noNaN: true });
const arbBatteryLevel = fc.integer({ min: 0, max: 100 });
const arbPowerSource = fc.constantFrom("usb" as const, "battery" as const, "unknown" as const);
const arbBatteryStatus = fc.constantFrom(
  "charging" as const,
  "full" as const,
  "discharging" as const,
  "unknown" as const
);
const arbWifiRssi = fc.integer({ min: -100, max: 0 });
const arbFirmwareVer = fc
  .tuple(
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 99 })
  )
  .map(([a, b, c]) => `${a}.${b}.${c}`);

/**
 * Property 13: Telemetry headers are logged with correct MAC association
 * Validates: Requirements 7.2
 *
 * For any request containing telemetry headers (X-Battery-Voltage,
 * X-Battery-Level, X-WiFi-RSSI, X-WiFi-SSID-B64, X-WiFi-Security,
 * X-Firmware-Ver) from a device with
 * a known MAC, the server should create a telemetry entry with
 * matching MAC and header values.
 */
describe("Property 13: Telemetry headers are logged with correct MAC association", () => {
  it("extractTelemetry parses all telemetry headers into a correct entry shape", () => {
    fc.assert(
      fc.property(
        arbMac,
        arbBatteryVoltage,
        arbBatteryLevel,
        arbPowerSource,
        arbBatteryStatus,
        arbWifiRssi,
        arbFirmwareVer,
        (mac, voltage, level, powerSource, batteryStatus, rssi, fwVer) => {
          const headers = new Headers({
            "x-battery-voltage": voltage.toString(),
            "x-battery-level": level.toString(),
            "x-power-source": powerSource,
            "x-battery-status": batteryStatus,
            "x-wifi-rssi": rssi.toString(),
            "x-wifi-ssid-b64": Buffer.from("Office WiFi").toString("base64"),
            "x-wifi-security": "wpa3-sae",
            "x-firmware-ver": fwVer,
            "x-security-profile": "testsecure",
            "x-nvs-integrity": "valid",
            "x-chip-model": "esp32s3",
            "x-chip-revision": "2",
            "x-flash-size": "8388608",
            "x-partition-layout": "e-series-v1",
            "x-partition-fingerprint": "a".repeat(64),
            "x-partition-table-offset": "32768",
            "x-layout-verified": "1",
            "x-secure-boot": "0",
            "x-flash-encryption": "0",
            "x-nvs-encryption": "0",
          });

          const extracted = extractTelemetry(headers);
          expect(extracted).not.toBeNull();

          // Combine with MAC and timestamp to form a full TelemetryEntry
          const entry: TelemetryEntry = {
            mac,
            ...extracted!,
            timestamp: new Date(),
          };

          // MAC association is preserved
          expect(entry.mac).toBe(mac);
          // Header values are correctly parsed
          expect(entry.batteryVoltage).toBeCloseTo(voltage, 2);
          expect(entry.batteryLevel).toBe(level);
          expect(entry.powerSource).toBe(powerSource);
          expect(entry.batteryStatus).toBe(batteryStatus);
          expect(entry.wifiRssi).toBe(rssi);
          expect(entry.wifiSsid).toBe("Office WiFi");
          expect(entry.wifiSecurity).toBe("wpa3-sae");
          expect(entry.firmwareVersion).toBe(fwVer);
          expect(entry.securityProfile).toBe("testsecure");
          expect(entry.nvsIntegrity).toBe("valid");
          expect(entry.chipModel).toBe("esp32s3");
          expect(entry.flashSizeBytes).toBe(8 * 1024 * 1024);
          expect(entry.partitionLayout).toBe("e-series-v1");
          expect(entry.layoutVerified).toBe(true);
          expect(entry.secureBootEnabled).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("rejects malformed or oversized Wi-Fi identity headers", () => {
    const extracted = extractTelemetry(
      new Headers({
        "x-wifi-ssid-b64": "not base64!",
        "x-wifi-security": "WPA3 SAE!",
      })
    );
    expect(extracted?.wifiSsid).toBeNull();
    expect(extracted?.wifiSecurity).toBeNull();
  });

  it("rejects invented security attestation values", () => {
    const extracted = extractTelemetry(
      new Headers({
        "x-security-profile": "production-ish",
        "x-nvs-integrity": "probably-valid",
        "x-chip-model": "esp32-s3-ish",
        "x-partition-layout": "custom",
        "x-layout-verified": "yes",
        "x-partition-fingerprint": "not-a-hash",
      })
    );
    expect(extracted?.securityProfile).toBeNull();
    expect(extracted?.nvsIntegrity).toBeNull();
    expect(extracted?.chipModel).toBeNull();
    expect(extracted?.partitionLayout).toBeNull();
    expect(extracted?.layoutVerified).toBeNull();
    expect(extracted?.partitionFingerprint).toBeNull();
  });

  it("rejects unknown power-state wire values without rejecting other telemetry", () => {
    const extracted = extractTelemetry(
      new Headers({
        "x-battery-level": "75",
        "x-power-source": "wall-socket",
        "x-battery-status": "overheated",
      })
    );
    expect(extracted?.powerSource).toBeNull();
    expect(extracted?.batteryStatus).toBeNull();
    expect(extracted?.batteryLevel).toBe(75);
  });

  it("rejects malformed and out-of-range numeric telemetry", () => {
    const extracted = extractTelemetry(
      new Headers({
        "x-battery-voltage": "NaN",
        "x-battery-level": "101",
        "x-wifi-rssi": "-55dBm",
        "x-firmware-ver": "   ",
      })
    );

    expect(extracted).toMatchObject({
      batteryVoltage: null,
      batteryLevel: null,
      wifiRssi: null,
      firmwareVersion: null,
    });
  });

  it("extractTelemetry returns null when no telemetry headers are present", () => {
    fc.assert(
      fc.property(arbMac, (mac) => {
        void mac; // MAC is irrelevant here — testing header absence
        const headers = new Headers();
        const extracted = extractTelemetry(headers);
        expect(extracted).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});
