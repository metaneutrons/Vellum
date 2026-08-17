// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  remoteConfigurationMessage,
  remoteWifiConfigurationMessage,
  serverMigrationPayloadSchema,
  signRemoteConfiguration,
  signRemoteWifiConfiguration,
  wifiConfigurationInputSchema,
} from "../remote-configuration";

describe("remote configuration authorization", () => {
  it("uses a stable, field-bound HMAC contract", () => {
    expect(
      signRemoteConfiguration({
        deviceToken: "01".repeat(32),
        id: "123e4567-e89b-12d3-a456-426614174000",
        serverUrl: "https://vellum.example.com/",
      })
    ).toBe("c5ce06dd38a44bf708316a97311137c6160827bcb1b3709cefcbe5c50c9c77cd");
    expect(
      remoteConfigurationMessage(
        "123e4567-e89b-12d3-a456-426614174000",
        "https://vellum.example.com/"
      )
    ).toBe(
      "vellum-remote-config-v1\n123e4567-e89b-12d3-a456-426614174000\nhttps://vellum.example.com"
    );
  });

  it("signs arbitrary Wi-Fi credentials with an unambiguous canonical contract", () => {
    expect(
      remoteWifiConfigurationMessage(
        "123e4567-e89b-12d3-a456-426614174000",
        "Office WiFi",
        "correct horse battery staple"
      )
    ).toBe(
      "vellum-remote-wifi-v1\n123e4567-e89b-12d3-a456-426614174000\nT2ZmaWNlIFdpRmk=\nY29ycmVjdCBob3JzZSBiYXR0ZXJ5IHN0YXBsZQ=="
    );
    expect(
      signRemoteWifiConfiguration({
        deviceToken: "01".repeat(32),
        id: "123e4567-e89b-12d3-a456-426614174000",
        ssid: "Office WiFi",
        password: "correct horse battery staple",
      })
    ).toBe("274ac50bacf2434bd6471f9f05b81170f634703883b9e005a017c31d6cd0e3ac");
  });

  it("enforces ESP Wi-Fi credential byte limits", () => {
    expect(() =>
      wifiConfigurationInputSchema.parse({ ssid: "x".repeat(33), password: "" })
    ).toThrow();
    expect(() =>
      wifiConfigurationInputSchema.parse({ ssid: "network", password: "x".repeat(65) })
    ).toThrow();
    expect(wifiConfigurationInputSchema.parse({ ssid: "open", password: "" })).toEqual({
      ssid: "open",
      password: "",
    });
  });

  it("requires HTTPS and rejects embedded canonicalization delimiters", () => {
    expect(() =>
      serverMigrationPayloadSchema.parse({ serverUrl: "http://vellum.local" })
    ).toThrow();
    expect(() =>
      serverMigrationPayloadSchema.parse({ serverUrl: "https://vellum.test/\nnext" })
    ).toThrow();
    expect(() =>
      serverMigrationPayloadSchema.parse({ serverUrl: "https://vellum.test/path" })
    ).toThrow();
    expect(() =>
      serverMigrationPayloadSchema.parse({ serverUrl: "https://user:pass@vellum.test" })
    ).toThrow();
  });
});
