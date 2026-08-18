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
  remoteOrientationMessage,
  signRemoteOrientation,
  REMOTE_ORIENTATION_CONTEXT,
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

describe("remote orientation command", () => {
  const token = "a".repeat(64);
  const id = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  it("binds the signature to its own context, not the server-url one", () => {
    const message = remoteOrientationMessage(id, "portrait");
    expect(message.startsWith(REMOTE_ORIENTATION_CONTEXT)).toBe(true);
    /* A signature valid across kinds would let one authorised change be replayed
     * as another. */
    expect(message).not.toContain("vellum-remote-config-v1");
    expect(message).not.toContain("vellum-remote-wifi-v1");
  });

  it("signs portrait and landscape differently", () => {
    const a = signRemoteOrientation({ deviceToken: token, id, orientation: "portrait" });
    const b = signRemoteOrientation({ deviceToken: token, id, orientation: "landscape" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("binds the signature to the command id", () => {
    const other = "4f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    expect(signRemoteOrientation({ deviceToken: token, id, orientation: "portrait" })).not.toBe(
      signRemoteOrientation({ deviceToken: token, id: other, orientation: "portrait" })
    );
  });

  it("rejects anything outside the closed set, and a bad id or token", () => {
    expect(() => remoteOrientationMessage(id, "sideways")).toThrow();
    expect(() => remoteOrientationMessage("not-a-uuid", "portrait")).toThrow();
    expect(() =>
      signRemoteOrientation({ deviceToken: "short", id, orientation: "portrait" })
    ).toThrow();
  });
});
