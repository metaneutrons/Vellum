// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, withDbRead, withDbWrite } from "@/db";
import { deviceConfigurationCommands, devices } from "@/db/schema";
import { renderQuerySchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { resolveOta } from "@/lib/firmware";
import { asFirmwareChannel } from "@/lib/firmware-channel";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";
import { settingsForDevice } from "@/lib/settings/for-device";
import { resolveRefreshProfile } from "@/lib/settings/refresh-profile";
import { evaluateBrightness, parseBrightnessPolicy } from "@/lib/settings/brightness";
import { log } from "@/lib/logger";
import { env } from "@/lib/env";
import { createOtaDownloadUrl } from "@/lib/firmware-download";
import { completeDisplayCaps, displayCapsSchema, parseDisplayCapsHeader } from "@/lib/display";
import { decryptCredentials } from "@/lib/encryption";
import {
  encryptedWifiPayloadSchema,
  serverMigrationPayloadSchema,
  signRemoteConfiguration,
  signRemoteWifiConfiguration,
  signRemoteOrientation,
  orientationPayloadSchema,
  wifiConfigurationInputSchema,
} from "@/lib/provisioning/remote-configuration";
import { asRecord } from "@/lib/record-value";

export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  const mac = request.nextUrl.searchParams.get("mac");
  const validation = validateRequest(renderQuerySchema, { mac });
  if (!validation.success) return validation.response;

  const token = request.headers.get("x-device-token") ?? "";
  const isValid = await validateToken(validation.data.mac, token);
  if (!isValid) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  // Load device for channel + pin info — through the resilience layer (circuit
  // breaker + retry) like every other DB access on the hot device path.
  const [device] = await withDbRead(
    () => db.select().from(devices).where(eq(devices.mac, validation.data.mac)).limit(1),
    "config-get-device"
  );

  // Resolve OTA update.
  //
  // The model is taken from the request header first, then from the stored
  // capabilities. Both matter: `/hello` is the only path that persists
  // displayCaps, and a device enrolled through a provisioning voucher is
  // approved with a token immediately — so it never calls `/hello` again and its
  // displayCaps stay NULL. That resolved to "unknown", no manifest entry
  // matched, and the device silently never received an OTA update (observed in
  // the field on a D1001 stuck on an old firmware while rendering normally).
  // The header is sent on this very request, so preferring it makes such a
  // device self-heal on its next poll instead of needing a re-enrolment.
  const firmwareVer = request.headers.get("x-firmware-ver") ?? "0.0.0";
  const headerModel = request.headers.get("x-display-model")?.trim() || null;
  const storedModel = (device?.displayCaps as { model?: string } | null)?.model ?? null;
  const displayModel = headerModel ?? storedModel ?? "unknown";
  const t = extractTelemetry(request.headers);

  // Voucher-enrolled devices can skip /hello entirely. Older self-healing only
  // persisted their model, leaving width/height/format absent forever. Complete
  // any missing/partial record from the central registry on the next ordinary
  // authenticated poll; no re-provisioning or one-off migration is required.
  const storedCapsValid = displayCapsSchema.safeParse(device?.displayCaps).success;
  const completedCaps = headerModel ? completeDisplayCaps(device?.displayCaps, headerModel) : null;

  /* The device also reports its drawable surface and the mountings it supports on
   * every poll. Adopt those three fields: the driver is the only thing that knows
   * them, and pinning them to enrolment is what let a D1001 keep advertising
   * portrait 800x1280 after its surface became landscape 1280x800.
   *
   * Deliberately narrow. orientationOverride is a separate column and is never
   * touched here: the mounting an operator chose is a decision, not a measurement,
   * and a device must not be able to overrule it. */
  const reported = parseDisplayCapsHeader(request.headers.get("x-display-caps"));
  const baseCaps = completedCaps ?? (storedCapsValid ? device?.displayCaps : null);
  const adoptedCaps =
    reported && baseCaps
      ? {
          ...(baseCaps as Record<string, unknown>),
          width: reported.width,
          height: reported.height,
          orientation: reported.orientation,
          orientations: reported.orientations,
          /* Same rule as mergeReportedCaps: only touch the flag when it says
           * something or the row already carries it, or every device on firmware
           * without it would look changed on every poll. */
          ...(reported.backlight || "backlight" in (baseCaps as Record<string, unknown>)
            ? { backlight: reported.backlight }
            : {}),
        }
      : null;
  const capsChanged =
    adoptedCaps !== null &&
    JSON.stringify(adoptedCaps) !== JSON.stringify(device?.displayCaps ?? null);

  if (device && adoptedCaps && capsChanged) {
    await withDbWrite(
      () =>
        db
          .update(devices)
          .set({ displayCaps: adoptedCaps })
          .where(eq(devices.mac, validation.data.mac)),
      "config-adopt-reported-display-caps"
    ).catch((error: unknown) =>
      log.warn("Failed to persist reported display capabilities", {
        mac: validation.data.mac,
        error: String(error),
      })
    );
  } else if (device && completedCaps && (!storedCapsValid || storedModel !== headerModel)) {
    await withDbWrite(
      () =>
        db
          .update(devices)
          .set({ displayCaps: completedCaps })
          .where(eq(devices.mac, validation.data.mac)),
      "config-backfill-display-caps"
    ).catch((error: unknown) =>
      log.warn("Failed to persist display capability backfill", {
        mac: validation.data.mac,
        error: String(error),
      })
    );
  }

  const ota = await resolveOta(
    firmwareVer,
    displayModel,
    asFirmwareChannel(device?.firmwareChannel),
    device?.firmwarePinVersion ?? null,
    validation.data.mac,
    t
  );

  // Existing firmware already accepts arbitrary validated HTTPS OTA URLs, so
  // routing through Vellum needs no device-side migration. In local HTTP
  // development, retain the GitHub URL because production firmware correctly
  // refuses plaintext OTA transport.
  const otaOrigin = env.VELLUM_PUBLIC_URL ?? request.nextUrl.origin;
  const otaUrl =
    ota.otaUrl && ota.otaTag && otaOrigin.startsWith("https://")
      ? createOtaDownloadUrl(
          otaOrigin,
          {
            mac: validation.data.mac,
            tag: ota.otaTag,
            model: displayModel,
          },
          token
        )
      : ota.otaUrl;
  const { otaTag: _otaTag, ...publicOta } = ota;

  const [activeCommand] = await withDbRead(
    () =>
      db
        .select({
          id: deviceConfigurationCommands.id,
          kind: deviceConfigurationCommands.kind,
          payload: deviceConfigurationCommands.payload,
          status: deviceConfigurationCommands.status,
        })
        .from(deviceConfigurationCommands)
        .where(
          and(
            eq(deviceConfigurationCommands.mac, validation.data.mac),
            inArray(deviceConfigurationCommands.status, ["pending", "delivered", "applying"])
          )
        )
        .limit(1),
    "config-get-active-command"
  );

  let remoteConfiguration:
    | { protocol: 1; id: string; kind: "server_url"; serverUrl: string; signature: string }
    | {
        protocol: 1;
        id: string;
        kind: "wifi";
        ssid: string;
        password: string;
        signature: string;
      }
    | {
        protocol: 1;
        id: string;
        kind: "orientation";
        orientation: string;
        signature: string;
      }
    | undefined;
  if (activeCommand?.kind === "server_url" && device?.token) {
    const parsed = serverMigrationPayloadSchema.safeParse(activeCommand.payload);
    if (parsed.success) {
      remoteConfiguration = {
        protocol: 1,
        id: activeCommand.id,
        kind: "server_url",
        serverUrl: parsed.data.serverUrl,
        signature: signRemoteConfiguration({
          deviceToken: device.token,
          id: activeCommand.id,
          serverUrl: parsed.data.serverUrl,
        }),
      };
    } else {
      log.error("Invalid persisted device configuration command", {
        mac: validation.data.mac,
        commandId: activeCommand.id,
      });
    }
  }
  if (activeCommand?.kind === "wifi" && device?.token) {
    const payload = encryptedWifiPayloadSchema.safeParse(activeCommand.payload);
    try {
      if (!payload.success) throw new Error("invalid_encrypted_wifi_payload");
      const secret = asRecord(decryptCredentials(payload.data.encryptedPassword));
      const parsed = wifiConfigurationInputSchema.parse({
        ssid: payload.data.ssid,
        password: secret.password,
      });
      remoteConfiguration = {
        protocol: 1,
        id: activeCommand.id,
        kind: "wifi",
        ssid: parsed.ssid,
        password: parsed.password,
        signature: signRemoteWifiConfiguration({
          deviceToken: device.token,
          id: activeCommand.id,
          ssid: parsed.ssid,
          password: parsed.password,
        }),
      };
    } catch (error) {
      log.error("Unable to decrypt persisted Wi-Fi configuration command", {
        mac: validation.data.mac,
        commandId: activeCommand.id,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      await withDbWrite(
        () =>
          db
            .update(deviceConfigurationCommands)
            .set({
              status: "failed",
              errorCode: "credential_decryption_failed",
              completedAt: new Date(),
            })
            .where(eq(deviceConfigurationCommands.id, activeCommand.id)),
        "config-fail-undecryptable-wifi-command"
      );
    }
  }

  if (activeCommand?.kind === "orientation" && device?.token) {
    /* The mounting is not a secret, but it is authenticated: an attacker who could
     * rotate a wall panel's surface could make it unreadable, and the device applies
     * this by rebooting. */
    const parsed = orientationPayloadSchema.safeParse(activeCommand.payload);
    if (parsed.success) {
      remoteConfiguration = {
        protocol: 1,
        id: activeCommand.id,
        kind: "orientation",
        orientation: parsed.data.orientation,
        signature: signRemoteOrientation({
          deviceToken: device.token,
          id: activeCommand.id,
          orientation: parsed.data.orientation,
        }),
      };
    } else {
      log.error("Invalid persisted device orientation command", {
        mac: validation.data.mac,
        commandId: activeCommand.id,
      });
    }
  }

  if (remoteConfiguration && activeCommand?.status === "pending") {
    await withDbWrite(
      () =>
        db
          .update(deviceConfigurationCommands)
          .set({ status: "delivered", deliveredAt: new Date() })
          .where(
            and(
              eq(deviceConfigurationCommands.id, activeCommand.id),
              eq(deviceConfigurationCommands.status, "pending")
            )
          ),
      "config-mark-command-delivered"
    ).catch((error: unknown) =>
      log.warn("Failed to mark device configuration command delivered", {
        mac: validation.data.mac,
        commandId: activeCommand.id,
        error: String(error),
      })
    );
  }

  if (t)
    logTelemetry({ ...t, mac: validation.data.mac, timestamp: new Date() }).catch(
      (error: unknown) =>
        log.warn("Config telemetry persistence failed", {
          mac: validation.data.mac,
          error: String(error),
        })
    );

  /* Backlight brightness, resolved to a single number the device just applies.
   *
   * Only sent when the panel reports a backlight: no e-paper model has one, and
   * firmware predating the capability flag reports none, so nothing is sent to a
   * device that could not honour it. The device learns neither the schedule nor
   * the timezone, which keeps clock logic out of the firmware and lets a schedule
   * change take effect on the next poll. */
  /* Taken from the header of THIS poll, not from the stored row: the row is
   * whatever the last adoption wrote, and a device that just gained the
   * capability should not have to wait a cycle to be dimmable. */
  const hasBacklight =
    reported?.backlight ?? (device?.displayCaps as { backlight?: boolean } | null)?.backlight;
  let backlightPercent: number | undefined;
  if (hasBacklight && device) {
    const settings = await settingsForDevice(device);
    const assignedProfile = await resolveRefreshProfile(settings.values.refreshProfileId);
    backlightPercent = evaluateBrightness({
      policy: parseBrightnessPolicy(assignedProfile),
      /* Unknown source is treated conservatively exactly as /render does. */
      powerSource: t?.powerSource === "usb" ? "usb" : "battery",
      now: new Date(),
      timezone: settings.values.timezone ?? undefined,
      override: device.backlightPercent,
    }).percent;
  }

  return Response.json(
    okResponse({
      ...publicOta,
      otaUrl,
      rotation: 0,
      remoteConfiguration,
      /* Diagnostics verbosity. Off means the device reports only warnings and
       * errors, which is what keeps a fleet from becoming a firehose; an operator
       * raises one device while debugging it. */
      logVerbose: device?.logVerbose === true,
      backlightPercent,
    })
  );
}
