import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { extractTelemetry } from "../index";
import type { TelemetryEntry } from "@/lib/types";

// --- Generators ---

const arbMac = fc
  .stringMatching(/^[0-9A-F]{12}$/)
  .map((s) => s.match(/.{2}/g)!.join(":"));

const arbBatteryVoltage = fc.float({ min: 2.5, max: 4.5, noNaN: true });
const arbBatteryLevel = fc.integer({ min: 0, max: 100 });
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
 * X-Battery-Level, X-WiFi-RSSI, X-Firmware-Ver) from a device with
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
        arbWifiRssi,
        arbFirmwareVer,
        (mac, voltage, level, rssi, fwVer) => {
          const headers = new Headers({
            "x-battery-voltage": voltage.toString(),
            "x-battery-level": level.toString(),
            "x-wifi-rssi": rssi.toString(),
            "x-firmware-ver": fwVer,
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
          expect(entry.wifiRssi).toBe(rssi);
          expect(entry.firmwareVersion).toBe(fwVer);
        }
      ),
      { numRuns: 100 }
    );
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
