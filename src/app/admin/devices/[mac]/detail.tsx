// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  cancelDeviceConfigurationCommand,
  queueDeviceServerMigration,
  queueDeviceWifiConfiguration,
  updateDevice,
  setDeviceLogVerbose,
  setDeviceSite,
  setDeviceBacklight,
} from "../../actions";
import { useToast } from "@/components/toast";
import { Card as UiCard } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/badge";
import { OtaEventList, type OtaEvent } from "@/components/ota-event-list";
import { deviceConnectivity } from "@/lib/connectivity";
import { fmtInterval } from "@/lib/duration";
import { deviceName } from "@/lib/device-name";
import { assessSecurityPosture } from "@/lib/security-posture";

/**
 * Four columns were missing from this type, and that is why the view never
 * showed them: `orientationOverride`, `firmwareChannel`, `firmwarePinVersion` and
 * `timezone` are all per-device settings that `updateDevice` already accepts. The
 * page loads the whole row, so they were present at runtime the entire time and
 * simply invisible to the component.
 */
interface Device {
  mac: string;
  status: string;
  label: string | null;
  displayCaps: unknown;
  orientationOverride: string | null;
  firmwareChannel: string | null;
  firmwarePinVersion: string | null;
  timezone: string | null;
  contentInstanceId: string | null;
  themeId: string | null;
  refreshProfileId: string | null;
  approvedAt: Date | null;
  lastSeen: Date | null;
  expectedIntervalS: number | null;
  expectedDisplayState: "on" | "off";
  expectedDeviceState: "awake" | "sleep";
  expectedWakeAt: Date | null;
  logVerbose: boolean;
  siteId: string | null;
  backlightPercent: number | null;
  createdAt: Date;
}

interface TelemetryEntry {
  id: number;
  batteryVoltage: number | null;
  batteryLevel: number | null;
  powerSource: "usb" | "battery" | "unknown" | null;
  batteryStatus: "charging" | "full" | "discharging" | "unknown" | null;
  wifiRssi: number | null;
  wifiSsid: string | null;
  wifiSecurity: string | null;
  firmwareVersion: string | null;
  securityProfile: "development" | "testsecure" | "secureboot" | "production" | null;
  nvsIntegrity: "disabled" | "valid" | "invalid" | null;
  chipModel: "esp32s3" | "esp32p4" | "unknown" | null;
  chipRevision: number | null;
  flashSizeBytes: number | null;
  partitionLayout: "e-series-v1" | "e-series-secure-v1" | "d1001-v1" | "unknown" | null;
  partitionFingerprint: string | null;
  partitionTableOffset: number | null;
  layoutVerified: boolean | null;
  secureBootEnabled: boolean | null;
  nvsEncryptionEnabled: boolean | null;
  flashEncryptionEnabled: boolean | null;
  timestamp: Date;
}

interface Report {
  id: number;
  issue: string | null;
  timestamp: Date;
}

interface Props {
  device: Device;
  telemetryHistory: TelemetryEntry[];
  recentReports: Report[];
  themes: { id: string; name: string }[];
  contentInstances: { id: string; name: string }[];
  refreshProfiles: { id: string; name: string }[];
  configurationCommands: {
    id: string;
    kind: string;
    payload: unknown;
    status: string;
    errorCode: string | null;
    createdAt: Date;
    deliveredAt: Date | null;
    completedAt: Date | null;
  }[];
  sites: { id: string; name: string; timezone: string }[];
  effective: {
    values: {
      refreshProfileId: string | null;
      themeId: string | null;
      contentInstanceId: string | null;
      timezone: string | null;
    };
    from: Partial<
      Record<"refreshProfileId" | "themeId" | "contentInstanceId" | "timezone", string>
    >;
  };
  logBatches: {
    id: number;
    seq: number;
    lines: string;
    byteLen: number;
    receivedAt: Date;
  }[];
  otaEvents: OtaEvent[];
  canProvision: boolean;
}

/**
 * A titled card, on the design system's surface rather than on `bg-white`.
 *
 * The whole of this view predates the Aurora tokens and painted itself from the
 * raw Tailwind palette: a white card, grey labels, and light chips, none of which
 * has a dark variant. Since the theme defaults to `system` and flips a `.dark`
 * class on `<html>`, that meant a white card on a black page, and a log block with
 * a near-white ground and no foreground colour of its own — hence unreadable text.
 */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <UiCard className="p-5">
      <h3 className="mb-3 text-sm font-semibold tracking-wide text-label-secondary uppercase">
        {title}
      </h3>
      {children}
    </UiCard>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-xs text-label-secondary">{label}</div>
      <div className={`text-lg font-semibold ${warn ? "text-red" : ""}`}>{value}</div>
    </div>
  );
}

export function DeviceDetail({
  device,
  telemetryHistory,
  recentReports,
  themes,
  contentInstances,
  refreshProfiles,
  configurationCommands,
  sites,
  effective,
  logBatches,
  otaEvents,
  canProvision,
}: Props) {
  const t = useTranslations("devices");
  const locale = useLocale();
  const nameFor = (list: { id: string; name: string }[], id: string | null) =>
    id ? (list.find((x) => x.id === id)?.name ?? id) : t("site.notSet");
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [serverUrl, setServerUrl] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const reportedModel = (device.displayCaps as { model?: unknown } | null)?.model;
  const testsecureModel =
    typeof reportedModel === "string" && reportedModel.length > 0
      ? reportedModel.toLowerCase()
      : "<model>";
  /* `quantize` is the LEGACY shape, migrated to format + colorMode in
   * lib/display.ts. No device in the estate reports it, so the card's "Quantize"
   * row read "—" on every single display while the panel's colour mode, palette
   * size, orientation and backlight sat unread in the same object. */
  const caps = device.displayCaps as {
    model?: string;
    width?: number;
    height?: number;
    format?: string;
    colorMode?: string;
    palette?: unknown[];
    orientation?: string;
    orientations?: string[];
    backlight?: boolean;
  } | null;
  const latest = telemetryHistory[0];
  const securityAssessment = latest
    ? assessSecurityPosture(latest, typeof reportedModel === "string" ? reportedModel : "unknown")
    : null;
  const activeConfiguration = configurationCommands.find((command) =>
    ["pending", "delivered", "applying"].includes(command.status)
  );
  const configurationApplying = activeConfiguration?.status === "applying";

  useEffect(() => {
    if (!activeConfiguration) return;
    const timer = window.setInterval(() => router.refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [activeConfiguration, router]);

  // Connectivity (liveness) is separate from authorization status, and judged
  // against the device's own expected cadence — see src/lib/connectivity.ts.
  const connState = deviceConnectivity(
    device.lastSeen ? new Date(device.lastSeen).getTime() : null,
    device.expectedIntervalS,
    Date.now()
  );
  /* Tone AND wording, never colour alone: the pill carries a label, so the state
   * survives a greyscale screenshot and a colour-blind reader. */
  const conn = {
    online: { label: t("connectivity.online"), tone: "green" as const },
    late: { label: t("connectivity.late"), tone: "orange" as const },
    offline: { label: t("connectivity.offline"), tone: "red" as const },
    never: { label: t("connectivity.never"), tone: "neutral" as const },
  }[connState];

  /** Empty means "no name": the fallback chain in `deviceName` takes over. */
  function renameDevice(value: string) {
    const label = value.trim() || null;
    if (label === (device.label ?? null)) return;
    handleUpdate({ label });
  }

  function handleUpdate(data: {
    label?: string | null;
    contentInstanceId?: string | null;
    themeId?: string | null;
    refreshProfileId?: string | null;
  }) {
    startTransition(async () => {
      try {
        await updateDevice(device.mac, data);
        toast("success", t("toast.updated"));
      } catch {
        toast("error", t("toast.updateFailed"));
      }
    });
  }

  function applyBacklight(value: number | null) {
    startTransition(async () => {
      try {
        await setDeviceBacklight(device.mac, value);
        toast("success", t("toast.updated"));
        router.refresh();
      } catch {
        toast("error", t("toast.updateFailed"));
      }
    });
  }

  function assignSite(siteId: string) {
    startTransition(async () => {
      try {
        await setDeviceSite(device.mac, siteId || null);
        toast("success", t("toast.updated"));
        router.refresh();
      } catch {
        toast("error", t("toast.updateFailed"));
      }
    });
  }

  function toggleVerbose() {
    startTransition(async () => {
      try {
        await setDeviceLogVerbose(device.mac, !device.logVerbose);
        toast("success", t("toast.updated"));
        router.refresh();
      } catch {
        toast("error", t("toast.updateFailed"));
      }
    });
  }

  function queueServerMigration() {
    const target = serverUrl.trim();
    if (!target) return;
    if (!window.confirm(t("remoteConfig.confirm", { url: target }))) return;
    startTransition(async () => {
      try {
        await queueDeviceServerMigration(device.mac, target);
        setServerUrl("");
        toast("success", t("remoteConfig.queued"));
        router.refresh();
      } catch {
        toast("error", t("remoteConfig.queueFailed"));
      }
    });
  }

  function queueWifiConfiguration() {
    if (!wifiSsid) return;
    if (!window.confirm(t("remoteConfig.wifiConfirm", { ssid: wifiSsid }))) return;
    startTransition(async () => {
      try {
        await queueDeviceWifiConfiguration(device.mac, wifiSsid, wifiPassword);
        setWifiSsid("");
        setWifiPassword("");
        toast("success", t("remoteConfig.wifiQueued"));
        router.refresh();
      } catch {
        toast("error", t("remoteConfig.wifiQueueFailed"));
      }
    });
  }

  function cancelConfiguration(id: string) {
    startTransition(async () => {
      try {
        await cancelDeviceConfigurationCommand(device.mac, id);
        toast("success", t("remoteConfig.cancelled"));
        router.refresh();
      } catch {
        toast("error", t("remoteConfig.cancelFailed"));
      }
    });
  }

  function configurationStatus(status: string) {
    switch (status) {
      case "pending":
        return t("remoteConfig.status.pending");
      case "delivered":
        return t("remoteConfig.status.delivered");
      case "applying":
        return t("remoteConfig.status.applying");
      case "applied":
        return t("remoteConfig.status.applied");
      case "failed":
        return t("remoteConfig.status.failed");
      case "superseded":
        return t("remoteConfig.status.superseded");
      case "cancelled":
        return t("remoteConfig.status.cancelled");
      default:
        return status;
    }
  }

  function configurationError(error: string) {
    switch (error) {
      case "invalid_signature":
        return t("remoteConfig.error.invalid_signature");
      case "target_validation_failed":
        return t("remoteConfig.error.target_validation_failed");
      case "storage_failed":
        return t("remoteConfig.error.storage_failed");
      case "wifi_connection_failed":
        return t("remoteConfig.error.wifi_connection_failed");
      case "server_reconnect_failed":
        return t("remoteConfig.error.server_reconnect_failed");
      case "interrupted":
        return t("remoteConfig.error.interrupted");
      case "credential_decryption_failed":
        return t("remoteConfig.error.credential_decryption_failed");
      default:
        return error;
    }
  }

  return (
    <div className={pending ? "opacity-60 pointer-events-none" : ""}>
      {/* Header. The name an operator gave it leads, the address stays beside it
          because that is what the sticker on the back says, and the assigned room
          is underneath because it is what the display is FOR. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          {canProvision ? (
            <input
              className="-mx-1 w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-2xl font-bold text-label hover:border-separator focus:border-separator focus-ring"
              defaultValue={device.label ?? ""}
              placeholder={device.mac}
              aria-label={t("renameLabel")}
              maxLength={64}
              onBlur={(e) => renameDevice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = device.label ?? "";
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <h1 className={`text-2xl font-bold ${device.label ? "" : "font-mono"}`}>
              {deviceName(device)}
            </h1>
          )}
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-label-secondary">
            {device.label && <span className="font-mono text-label-tertiary">{device.mac}</span>}
            <span>
              {contentInstances.find((c) => c.id === effective.values.contentInstanceId)?.name ??
                t("noContent")}
            </span>
          </p>
        </div>
        <StatusPill
          tone={
            device.status === "approved" ? "accent" : device.status === "pending" ? "orange" : "red"
          }
        >
          {t(`status.${device.status}`)}
        </StatusPill>
        <StatusPill tone={conn.tone} dot>
          {conn.label}
        </StatusPill>
        {device.expectedDeviceState === "sleep" ? (
          <StatusPill tone="neutral">{t("powerPolicy.sleeping")}</StatusPill>
        ) : device.expectedDisplayState === "off" ? (
          <StatusPill tone="neutral">{t("powerPolicy.displayOff")}</StatusPill>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Telemetry */}
        <Card title={t("telemetry")}>
          {latest ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label={t("battery")}
                value={`${latest.batteryLevel ?? "—"}%`}
                warn={(latest.batteryLevel ?? 100) < 20}
              />
              <Stat label={t("voltage")} value={`${latest.batteryVoltage?.toFixed(2) ?? "—"}V`} />
              <Stat
                label={t("power.source")}
                value={
                  latest.batteryStatus && latest.batteryStatus !== "unknown"
                    ? t(`power.${latest.batteryStatus}`)
                    : latest.powerSource
                      ? t(`power.${latest.powerSource}`)
                      : "—"
                }
              />
              <Stat
                label={t("wifiRssi")}
                value={`${latest.wifiRssi ?? "—"} dBm`}
                warn={(latest.wifiRssi ?? 0) < -70}
              />
              <Stat label={t("wifiNetwork")} value={latest.wifiSsid ?? "—"} />
              <Stat label={t("wifiSecurity")} value={latest.wifiSecurity ?? "—"} />
              <Stat label={t("firmware")} value={latest.firmwareVersion ?? "—"} />
              <Stat
                label={t("security.profile")}
                value={
                  latest.securityProfile ? t(`security.profiles.${latest.securityProfile}`) : "—"
                }
                warn={latest.securityProfile === "development"}
              />
              <Stat
                label={t("security.nvsIntegrity")}
                value={latest.nvsIntegrity ? t(`security.integrity.${latest.nvsIntegrity}`) : "—"}
                warn={latest.nvsIntegrity === "invalid"}
              />
              {/* Collected all along, and the only one of the three encryption
                  facts the card did not print. */}
              <Stat
                label={t("nvsEncryption")}
                value={
                  latest.nvsEncryptionEnabled === null
                    ? "—"
                    : latest.nvsEncryptionEnabled
                      ? t("security.enabled")
                      : t("security.disabled")
                }
              />
              <Stat label={t("security.chip")} value={latest.chipModel ?? "—"} />
              <Stat
                label={t("security.flashSize")}
                value={
                  latest.flashSizeBytes
                    ? `${Math.round(latest.flashSizeBytes / 1024 / 1024)} MiB`
                    : "—"
                }
              />
              <Stat
                label={t("security.partitionLayout")}
                value={latest.partitionLayout ?? "—"}
                warn={latest.layoutVerified === false || latest.partitionLayout === "unknown"}
              />
              <Stat
                label={t("security.runtimeState")}
                value={securityAssessment ? t(`security.states.${securityAssessment.state}`) : "—"}
                warn={securityAssessment?.verified === false}
              />
              <Stat
                label={t("security.secureBoot")}
                value={
                  latest.secureBootEnabled === null
                    ? "—"
                    : t(latest.secureBootEnabled ? "security.enabled" : "security.disabled")
                }
              />
              <Stat
                label={t("security.flashEncryption")}
                value={
                  latest.flashEncryptionEnabled === null
                    ? "—"
                    : t(latest.flashEncryptionEnabled ? "security.enabled" : "security.disabled")
                }
              />
            </div>
          ) : (
            <p className="text-sm text-label-tertiary">{t("noTelemetry")}</p>
          )}
        </Card>

        {/* Display */}
        <Card title={t("display")}>
          {caps ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat label={t("model")} value={caps.model ?? "—"} />
              <Stat
                label={t("resolution")}
                value={caps.width && caps.height ? `${caps.width}×${caps.height}` : "—"}
              />
              <Stat
                label={t("colorMode")}
                value={caps.colorMode ? t(`colorModes.${caps.colorMode}`) : "—"}
              />
              <Stat
                label={t("colors")}
                value={caps.palette?.length ? String(caps.palette.length) : "—"}
              />
              <Stat
                label={t("orientation")}
                value={
                  device.orientationOverride
                    ? t(
                        `orientation${device.orientationOverride === "portrait" ? "Portrait" : "Landscape"}`
                      )
                    : caps.orientation
                      ? t(
                          `orientation${caps.orientation === "portrait" ? "Portrait" : "Landscape"}`
                        )
                      : "—"
                }
              />
              {caps.backlight && (
                <Stat label={t("backlight.label")} value={t("backlightSupported")} />
              )}
            </div>
          ) : (
            <p className="text-sm text-label-tertiary">{t("noDisplayCaps")}</p>
          )}
        </Card>

        {/* Firmware. Both of these are per-device columns that `updateDevice`
            already accepts, and neither had ever been rendered, so the channel a
            display follows was invisible from the display's own page. */}
        <Card title={t("firmware")}>
          <div className="grid grid-cols-2 gap-4">
            <Stat
              label={t("channel")}
              value={device.firmwareChannel ? t(`channels.${device.firmwareChannel}`) : "—"}
            />
            <Stat label={t("version")} value={latest?.firmwareVersion ?? "—"} />
            {device.firmwarePinVersion && (
              <Stat label={t("pinnedTo")} value={device.firmwarePinVersion} warn />
            )}
          </div>
        </Card>

        {/* Timestamps */}
        <Card title={t("timeline")}>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-label-secondary">{t("registered")}:</span>{" "}
              {new Date(device.createdAt).toLocaleString(locale)}
            </div>
            {device.approvedAt && (
              <div>
                <span className="text-label-secondary">{t("approvedAt")}:</span>{" "}
                {new Date(device.approvedAt).toLocaleString(locale)}
              </div>
            )}
            <div>
              <span className="text-label-secondary">{t("lastSeen")}:</span>{" "}
              {device.lastSeen ? new Date(device.lastSeen).toLocaleString(locale) : "—"}
            </div>
            {/* "Last seen two weeks ago" is unreadable as a health signal without
                the cadence beside it: this display sleeps for 20 575 s between
                calls, so two weeks may be perfectly healthy or long dead. Both
                numbers were already on the page; only their difference was. */}
            {device.expectedIntervalS !== null && (
              <div>
                <span className="text-label-secondary">{t("checkInEvery")}:</span>{" "}
                {fmtInterval(device.expectedIntervalS)}
              </div>
            )}
            {device.lastSeen && device.expectedIntervalS !== null && (
              <div>
                <span className="text-label-secondary">{t("nextExpected")}:</span>{" "}
                {new Date(
                  new Date(device.lastSeen).getTime() + device.expectedIntervalS * 1000
                ).toLocaleString(locale)}
              </div>
            )}
            {device.expectedWakeAt &&
              (device.expectedDeviceState === "sleep" || device.expectedDisplayState === "off") && (
                <div>
                  <span className="text-label-secondary">{t("powerPolicy.until")}:</span>{" "}
                  {new Date(device.expectedWakeAt).toLocaleString(locale)}
                </div>
              )}
          </div>
        </Card>
      </div>

      <div className="mb-6">
        <Card title={t("security.title")}>
          <p className="mb-4 text-sm text-label-secondary">{t("security.description")}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              {
                done: device.status === "approved",
                label: t("security.steps.enrolled"),
              },
              {
                done: securityAssessment?.state === "testsecure" && securityAssessment.verified,
                label: t("security.steps.testsecure"),
              },
              {
                done: securityAssessment?.verified === true && latest?.nvsIntegrity === "valid",
                label: t("security.steps.hmacNvs"),
              },
            ].map((step) => (
              <div
                key={step.label}
                className={`rounded border p-3 text-sm ${step.done ? "border-green/30 bg-green/10 text-green" : "border-separator bg-surface-secondary text-label-secondary"}`}
              >
                <span className="mr-2" aria-hidden="true">
                  {step.done ? "✓" : "○"}
                </span>
                {step.label}
              </div>
            ))}
          </div>
          {securityAssessment?.state === "testsecure" && securityAssessment.verified ? (
            <p className="mt-4 text-sm text-green">{t("security.reversibleComplete")}</p>
          ) : (
            <div className="mt-4 space-y-3">
              <code className="block overflow-x-auto rounded bg-fill-secondary px-3 py-2 font-mono text-xs text-label">
                {`make build MODEL=${testsecureModel} SECURE=1 SECURE_PROFILE=testsecure`}
              </code>
              <Link
                href="https://github.com/metaneutrons/Vellum/blob/main/docs/SECURE_BOOT_AND_KMS.md#phase-a--prove-the-chain-with-zero-burns-spare-board-reversible"
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
              >
                {t("security.flashTestsecure")}
              </Link>
              <p className="text-xs text-label-secondary">{t("security.testsecureHint")}</p>
            </div>
          )}
          <div className="mt-4 rounded border border-orange/30 bg-orange/10 p-3 text-sm text-orange">
            {t("security.productionLocked")}
          </div>
        </Card>
      </div>

      {/* Assignments */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title={t("contentAssignment")}>
          <select
            className="w-full rounded border border-separator bg-surface px-3 py-2 text-sm text-label"
            aria-label={t("contentAssignment")}
            value={device.contentInstanceId ?? ""}
            onChange={(e) => handleUpdate({ contentInstanceId: e.target.value || null })}
          >
            <option value="">— {t("none")} —</option>
            {contentInstances.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Card>
        <Card title={t("themeAssignment")}>
          <select
            className="w-full rounded border border-separator bg-surface px-3 py-2 text-sm text-label"
            aria-label={t("themeAssignment")}
            value={device.themeId ?? ""}
            onChange={(e) => handleUpdate({ themeId: e.target.value || null })}
          >
            <option value="">— {t("default")} —</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Card>
        <Card title={t("refreshProfile")}>
          <select
            className="w-full rounded border border-separator bg-surface px-3 py-2 text-sm text-label"
            aria-label={t("refreshProfile")}
            value={device.refreshProfileId ?? ""}
            onChange={(e) => handleUpdate({ refreshProfileId: e.target.value || null })}
          >
            <option value="">— {t("default")} —</option>
            {refreshProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Card>
      </div>

      <div className="mb-6">
        <Card title={t("remoteConfig.title")}>
          <p className="mb-4 text-sm text-label-secondary">{t("remoteConfig.description")}</p>
          {canProvision && (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="https://vellum.example.com"
                  aria-label={t("remoteConfig.serverUrl")}
                  className="min-w-0 flex-1 rounded border border-separator bg-surface px-3 py-2 text-sm text-label"
                  disabled={pending || configurationApplying}
                />
                <button
                  type="button"
                  onClick={queueServerMigration}
                  disabled={pending || configurationApplying || !serverUrl.trim()}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-40"
                >
                  {t("remoteConfig.migrate")}
                </button>
              </div>
              <p className="mt-2 text-xs text-label-secondary">{t("remoteConfig.safety")}</p>
              <div className="my-5 border-t" />
              <h4 className="mb-2 text-sm font-semibold">{t("remoteConfig.wifiTitle")}</h4>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <input
                  type="text"
                  value={wifiSsid}
                  onChange={(event) => setWifiSsid(event.target.value)}
                  placeholder={t("remoteConfig.wifiSsid")}
                  aria-label={t("remoteConfig.wifiSsid")}
                  maxLength={32}
                  className="min-w-0 rounded border border-separator bg-surface px-3 py-2 text-sm text-label"
                  disabled={pending || configurationApplying}
                />
                <input
                  type="password"
                  value={wifiPassword}
                  onChange={(event) => setWifiPassword(event.target.value)}
                  placeholder={t("remoteConfig.wifiPassword")}
                  aria-label={t("remoteConfig.wifiPassword")}
                  autoComplete="new-password"
                  maxLength={64}
                  className="min-w-0 rounded border border-separator bg-surface px-3 py-2 text-sm text-label"
                  disabled={pending || configurationApplying}
                />
                <button
                  type="button"
                  onClick={queueWifiConfiguration}
                  disabled={pending || configurationApplying || !wifiSsid}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-40"
                >
                  {t("remoteConfig.wifiChange")}
                </button>
              </div>
              <p className="mt-2 text-xs text-label-secondary">{t("remoteConfig.wifiSafety")}</p>
            </>
          )}

          {configurationCommands.length > 0 && (
            <div className="mt-5 space-y-2">
              {configurationCommands.map((command) => {
                const payload = command.payload as { serverUrl?: string; ssid?: string };
                const isActive = ["pending", "delivered"].includes(command.status);
                return (
                  <div
                    key={command.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-separator p-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {command.kind === "wifi"
                        ? t("remoteConfig.wifiHistory", { ssid: payload.ssid ?? "—" })
                        : (payload.serverUrl ?? "—")}
                    </span>
                    <StatusPill
                      tone={
                        command.status === "applied"
                          ? "green"
                          : command.status === "failed"
                            ? "red"
                            : "orange"
                      }
                    >
                      {configurationStatus(command.status)}
                    </StatusPill>
                    {command.errorCode && (
                      <span className="text-xs text-red">
                        {configurationError(command.errorCode)}
                      </span>
                    )}
                    {isActive && canProvision && (
                      <button
                        type="button"
                        className="text-xs text-red hover:underline"
                        onClick={() => cancelConfiguration(command.id)}
                      >
                        {t("remoteConfig.cancel")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Site and effective settings. The provenance is the point: a cascade is
          only usable if the interface can say which layer supplied a value. */}
      <Card title={t("site.title")}>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            {t("site.assigned")}
            <select
              className="min-h-8 rounded-md border border-separator bg-surface-secondary px-2.5 text-[13px] text-label focus-ring"
              value={device.siteId ?? ""}
              disabled={!canProvision || pending}
              onChange={(e) => assignSite(e.target.value)}
            >
              <option value="">{t("site.none")}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <p className="min-w-0 flex-1 text-xs text-label-secondary">{t("site.hint")}</p>
        </div>

        <dl className="mt-4 space-y-1 text-xs">
          {(
            [
              ["timezone", effective.values.timezone ?? t("site.serverClock")],
              ["profile", nameFor(refreshProfiles, effective.values.refreshProfileId)],
              ["theme", nameFor(themes, effective.values.themeId)],
              ["content", nameFor(contentInstances, effective.values.contentInstanceId)],
            ] as const
          ).map(([key, value]) => {
            const source =
              effective.from[
                key === "profile"
                  ? "refreshProfileId"
                  : key === "theme"
                    ? "themeId"
                    : key === "content"
                      ? "contentInstanceId"
                      : "timezone"
              ] ?? "builtin";
            return (
              <div key={key} className="flex flex-wrap items-baseline gap-2">
                <dt className="w-24 text-label-secondary">{t(`site.${key}`)}</dt>
                <dd className="font-mono text-label">{value}</dd>
                <span className="text-label-secondary">{t(`site.from.${source}`)}</span>
              </div>
            );
          })}
        </dl>

        {/* Only where the panel says it has one. An e-paper display would show a
            slider that moves nothing, and the server refuses the value anyway. */}
        {(device.displayCaps as { backlight?: boolean } | null)?.backlight && (
          <div className="mt-4 border-t border-separator pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                {t("backlight.label")}
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  disabled={!canProvision || pending || device.backlightPercent === null}
                  value={device.backlightPercent ?? 80}
                  onChange={(e) => applyBacklight(Number(e.target.value))}
                  className="w-40"
                />
                <span className="w-12 font-mono text-sm text-label">
                  {device.backlightPercent === null ? "—" : `${device.backlightPercent}%`}
                </span>
              </label>
              {canProvision && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => applyBacklight(device.backlightPercent === null ? 80 : null)}
                  className="focus-ring rounded border border-separator px-3 py-1.5 text-xs font-medium text-label disabled:opacity-40"
                >
                  {device.backlightPercent === null
                    ? t("backlight.override")
                    : t("backlight.followProfile")}
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-label-secondary">
              {device.backlightPercent === null
                ? t("backlight.fromProfile")
                : t("backlight.overridden")}
            </p>
          </div>
        )}
      </Card>

      {/* Diagnostics. Uploads are event-driven, so an empty card means a healthy
          display, not a missing feature: the device reports only when something
          goes wrong, or while an operator raised it to report everything. */}
      <Card title={`${t("diagnostics.title")} (${logBatches.length})`}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-xs text-label-secondary">{t("diagnostics.hint")}</p>
          {canProvision && (
            <button
              type="button"
              disabled={pending}
              onClick={toggleVerbose}
              className="focus-ring rounded border border-separator px-3 py-1.5 text-xs font-medium text-label disabled:opacity-40"
            >
              {device.logVerbose ? t("diagnostics.stopVerbose") : t("diagnostics.startVerbose")}
            </button>
          )}
        </div>
        {device.logVerbose && (
          <p className="mt-2 text-xs text-orange">{t("diagnostics.verboseActive")}</p>
        )}
        {logBatches.length > 0 ? (
          <div className="mt-4 space-y-3">
            {logBatches.map((batch) => (
              <details key={batch.id} className="rounded border border-separator">
                <summary className="cursor-pointer px-3 py-2 text-xs text-label-secondary">
                  {new Date(batch.receivedAt).toLocaleString(locale)} · #{batch.seq} ·{" "}
                  {batch.byteLen} B
                </summary>
                {/* Ground AND foreground. This block used to name only the
                    background, so the text took whatever it inherited: grey on a
                    light grey panel in light mode, and near-white on the same
                    light grey once the theme followed the system into dark. */}
                <pre className="max-h-96 overflow-auto border-t border-separator bg-surface-secondary p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-label">
                  {batch.lines}
                </pre>
              </details>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-label-secondary">{t("diagnostics.empty")}</p>
        )}
      </Card>

      {/* Telemetry History */}
      {/* Firmware history. Above the telemetry table on purpose: when a display
          misbehaves, "which update did it take, and did it stick" is the first
          question, and it used to be answerable only from the firmware page. */}
      <Card title={`${t("firmwareHistory")} (${otaEvents.length})`}>
        <div className="-mx-5 -mb-5 divide-y divide-separator border-t border-separator">
          <OtaEventList events={otaEvents} />
        </div>
      </Card>

      <Card title={`${t("telemetryHistory")} (${telemetryHistory.length})`}>
        {telemetryHistory.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-label-secondary">
                <tr>
                  <th className="pr-4 py-1">{t("time")}</th>
                  <th className="pr-4 py-1">{t("battery")}</th>
                  <th className="pr-4 py-1">{t("voltage")}</th>
                  <th className="pr-4 py-1">{t("power.source")}</th>
                  <th className="pr-4 py-1">{t("rssi")}</th>
                  <th className="pr-4 py-1">{t("wifiNetwork")}</th>
                  <th className="pr-4 py-1">{t("wifiSecurity")}</th>
                  <th className="pr-4 py-1">{t("firmware")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {telemetryHistory.map((entry) => (
                  <tr key={entry.id}>
                    <td className="pr-4 py-1 text-label-secondary">
                      {new Date(entry.timestamp).toLocaleString(locale)}
                    </td>
                    <td
                      className={`pr-4 py-1 ${(entry.batteryLevel ?? 100) < 20 ? "text-red font-medium" : ""}`}
                    >
                      {entry.batteryLevel ?? "—"}%
                    </td>
                    <td className="pr-4 py-1">{entry.batteryVoltage?.toFixed(2) ?? "—"}V</td>
                    <td className="pr-4 py-1">
                      {entry.batteryStatus && entry.batteryStatus !== "unknown"
                        ? t(`power.${entry.batteryStatus}`)
                        : entry.powerSource
                          ? t(`power.${entry.powerSource}`)
                          : "—"}
                    </td>
                    <td
                      className={`pr-4 py-1 ${(entry.wifiRssi ?? 0) < -70 ? "text-red font-medium" : ""}`}
                    >
                      {entry.wifiRssi ?? "—"} dBm
                    </td>
                    <td className="pr-4 py-1">{entry.wifiSsid ?? "—"}</td>
                    <td className="pr-4 py-1">{entry.wifiSecurity ?? "—"}</td>
                    <td className="pr-4 py-1 text-label-secondary">
                      {entry.firmwareVersion ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-label-tertiary">{t("noTelemetry")}</p>
        )}
      </Card>

      {/* Reports */}
      {recentReports.length > 0 && (
        <div className="mt-4">
          <Card title={t("recentReports")}>
            <div className="space-y-2">
              {recentReports.map((r) => (
                <div key={r.id} className="flex justify-between text-sm border-b pb-2">
                  <span>{r.issue ?? "—"}</span>
                  <span className="text-xs text-label-tertiary">
                    {new Date(r.timestamp).toLocaleString(locale)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
