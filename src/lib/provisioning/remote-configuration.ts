// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import crypto from "node:crypto";
import { z } from "zod";

export const REMOTE_CONFIGURATION_CONTEXT = "vellum-remote-config-v1\n";
export const REMOTE_WIFI_CONTEXT = "vellum-remote-wifi-v1\n";

export const serverMigrationPayloadSchema = z.object({
  serverUrl: z
    .string()
    .trim()
    .max(255)
    .refine((value) => !/[\r\n]/.test(value), "server_url_contains_line_break")
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    }, "server_url_must_be_https_origin")
    .transform((value) => new URL(value).origin),
});

export type ServerMigrationPayload = z.infer<typeof serverMigrationPayloadSchema>;

export const wifiConfigurationInputSchema = z.object({
  ssid: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0"), "wifi_ssid_contains_null")
    .refine((value) => Buffer.byteLength(value, "utf8") <= 32, "wifi_ssid_too_long"),
  password: z
    .string()
    .refine((value) => !value.includes("\0"), "wifi_password_contains_null")
    .refine((value) => Buffer.byteLength(value, "utf8") <= 64, "wifi_password_too_long"),
});

export const encryptedWifiPayloadSchema = z.object({
  ssid: wifiConfigurationInputSchema.shape.ssid,
  encryptedPassword: z.string().min(1),
});

/** Canonical byte contract shared with firmware; URL validation excludes LF. */
export function remoteConfigurationMessage(id: string, serverUrl: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid_configuration_command_id");
  const payload = serverMigrationPayloadSchema.parse({ serverUrl });
  return `${REMOTE_CONFIGURATION_CONTEXT}${id.toLowerCase()}\n${payload.serverUrl}`;
}

export function signRemoteConfiguration(input: {
  deviceToken: string;
  id: string;
  serverUrl: string;
}): string {
  if (!/^[0-9a-f]{64}$/i.test(input.deviceToken)) throw new Error("invalid_device_token");
  return crypto
    .createHmac("sha256", input.deviceToken)
    .update(remoteConfigurationMessage(input.id, input.serverUrl), "utf8")
    .digest("hex");
}

/**
 * Canonical Wi-Fi command contract shared with firmware. Base64 makes arbitrary
 * UTF-8 credentials unambiguous without ever normalizing or trimming them.
 */
export function remoteWifiConfigurationMessage(id: string, ssid: string, password: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid_configuration_command_id");
  const parsed = wifiConfigurationInputSchema.parse({ ssid, password });
  return `${REMOTE_WIFI_CONTEXT}${id.toLowerCase()}\n${Buffer.from(parsed.ssid, "utf8").toString("base64")}\n${Buffer.from(parsed.password, "utf8").toString("base64")}`;
}

export function signRemoteWifiConfiguration(input: {
  deviceToken: string;
  id: string;
  ssid: string;
  password: string;
}): string {
  if (!/^[0-9a-f]{64}$/i.test(input.deviceToken)) throw new Error("invalid_device_token");
  return crypto
    .createHmac("sha256", input.deviceToken)
    .update(remoteWifiConfigurationMessage(input.id, input.ssid, input.password), "utf8")
    .digest("hex");
}
