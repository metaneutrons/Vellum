// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { createHmac, timingSafeEqual } from "node:crypto";

const GRANT_VERSION = "v1";
export const OTA_DOWNLOAD_TTL_SECONDS = 10 * 60;

export interface OtaDownloadGrant {
  mac: string;
  tag: string;
  model: string;
  expires: number;
}

function canonicalGrant(grant: OtaDownloadGrant): string {
  return [GRANT_VERSION, grant.mac, grant.tag, grant.model, String(grant.expires)].join("\n");
}

export function signOtaDownloadGrant(grant: OtaDownloadGrant, deviceToken: string): string {
  return createHmac("sha256", deviceToken).update(canonicalGrant(grant)).digest("hex");
}

export function verifyOtaDownloadGrant(
  grant: OtaDownloadGrant,
  signature: string,
  deviceToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isSafeInteger(grant.expires) || grant.expires < nowSeconds) return false;
  // Refuse grants with an excessive lifetime even if correctly signed. This
  // keeps a leaked URL short-lived when clocks or callers are misconfigured.
  if (grant.expires > nowSeconds + OTA_DOWNLOAD_TTL_SECONDS + 60) return false;
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signOtaDownloadGrant(grant, deviceToken), "hex");
  const supplied = Buffer.from(signature, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Create a device-scoped download URL without putting its bearer token into
 * logs, browser history, or proxy access logs. The URL itself is valid only for
 * one device/model/release tuple and expires quickly. */
export function createOtaDownloadUrl(
  origin: string,
  input: Omit<OtaDownloadGrant, "expires">,
  deviceToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const grant = { ...input, expires: nowSeconds + OTA_DOWNLOAD_TTL_SECONDS };
  const url = new URL("/api/v1/ink/firmware", origin);
  url.searchParams.set("mac", grant.mac);
  url.searchParams.set("tag", grant.tag);
  url.searchParams.set("model", grant.model);
  url.searchParams.set("expires", String(grant.expires));
  url.searchParams.set("signature", signOtaDownloadGrant(grant, deviceToken));
  return url.href;
}
