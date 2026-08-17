// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  cancelDeviceConfigurationCommand,
  queueDeviceServerMigration,
  queueDeviceWifiConfiguration,
  updateDevice,
} from "../../actions";
import { useToast } from "@/components/toast";
import { deviceConnectivity } from "@/lib/connectivity";

interface Device {
  mac: string;
  status: string;
  displayCaps: unknown;
  contentInstanceId: string | null;
  themeId: string | null;
  refreshProfileId: string | null;
  approvedAt: Date | null;
  lastSeen: Date | null;
  expectedIntervalS: number | null;
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
  canProvision: boolean;
}

function Badge({ label, color }: { label: string; color: string }) {
  return <span className={`px-2 py-1 rounded text-xs font-medium ${color}`}>{label}</span>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${warn ? "text-red-600" : ""}`}>{value}</div>
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
  canProvision,
}: Props) {
  const t = useTranslations("devices");
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
  const caps = device.displayCaps as {
    model?: string;
    width?: number;
    height?: number;
    quantize?: string;
  } | null;
  const latest = telemetryHistory[0];
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
  const conn = {
    online: { label: "Online", color: "bg-green-100 text-green-800" },
    late: { label: "Late", color: "bg-yellow-100 text-yellow-800" },
    offline: { label: "Offline", color: "bg-red-100 text-red-800" },
    never: { label: "Never seen", color: "bg-gray-100 text-gray-700" },
  }[connState];

  function handleUpdate(data: {
    contentInstanceId?: string | null;
    themeId?: string | null;
    refreshProfileId?: string | null;
  }) {
    startTransition(async () => {
      try {
        await updateDevice(device.mac, data);
        toast("success", "Device updated");
      } catch {
        toast("error", "Update failed");
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
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold font-mono">{device.mac}</h1>
        <Badge
          label={device.status}
          color={
            device.status === "approved"
              ? "bg-blue-100 text-blue-800"
              : device.status === "pending"
                ? "bg-yellow-100 text-yellow-800"
                : "bg-red-100 text-red-800"
          }
        />
        <Badge label={conn.label} color={conn.color} />
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
            </div>
          ) : (
            <p className="text-sm text-gray-400">{t("noTelemetry")}</p>
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
              <Stat label={t("quantize")} value={caps.quantize ?? "—"} />
            </div>
          ) : (
            <p className="text-sm text-gray-400">{t("noDisplayCaps")}</p>
          )}
        </Card>

        {/* Timestamps */}
        <Card title={t("timeline")}>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-gray-500">{t("registered")}:</span>{" "}
              {new Date(device.createdAt).toLocaleString("de-DE")}
            </div>
            {device.approvedAt && (
              <div>
                <span className="text-gray-500">{t("approvedAt")}:</span>{" "}
                {new Date(device.approvedAt).toLocaleString("de-DE")}
              </div>
            )}
            <div>
              <span className="text-gray-500">{t("lastSeen")}:</span>{" "}
              {device.lastSeen ? new Date(device.lastSeen).toLocaleString("de-DE") : "—"}
            </div>
          </div>
        </Card>
      </div>

      <div className="mb-6">
        <Card title={t("security.title")}>
          <p className="mb-4 text-sm text-gray-500">{t("security.description")}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              {
                done: device.status === "approved",
                label: t("security.steps.enrolled"),
              },
              {
                done: latest?.securityProfile === "testsecure",
                label: t("security.steps.testsecure"),
              },
              {
                done: latest?.nvsIntegrity === "valid",
                label: t("security.steps.hmacNvs"),
              },
            ].map((step) => (
              <div
                key={step.label}
                className={`rounded border p-3 text-sm ${step.done ? "border-green-300 bg-green-50 text-green-800" : "border-gray-200 bg-gray-50 text-gray-600"}`}
              >
                <span className="mr-2" aria-hidden="true">
                  {step.done ? "✓" : "○"}
                </span>
                {step.label}
              </div>
            ))}
          </div>
          {latest?.securityProfile === "testsecure" && latest.nvsIntegrity === "valid" ? (
            <p className="mt-4 text-sm text-green-700">{t("security.reversibleComplete")}</p>
          ) : (
            <div className="mt-4 space-y-3">
              <code className="block overflow-x-auto rounded bg-gray-950 px-3 py-2 text-xs text-gray-100">
                {`make build MODEL=${testsecureModel} SECURE=1 SECURE_PROFILE=testsecure`}
              </code>
              <Link
                href="https://github.com/metaneutrons/Vellum/blob/main/docs/SECURE_BOOT_AND_KMS.md#phase-a--prove-the-chain-with-zero-burns-spare-board-reversible"
                target="_blank"
                rel="noreferrer"
                className="inline-flex rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white"
              >
                {t("security.flashTestsecure")}
              </Link>
              <p className="text-xs text-gray-500">{t("security.testsecureHint")}</p>
            </div>
          )}
          <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {t("security.productionLocked")}
          </div>
        </Card>
      </div>

      {/* Assignments */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title={t("contentAssignment")}>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            aria-label={t("contentAssignment")}
            value={device.contentInstanceId ?? ""}
            onChange={(e) => handleUpdate({ contentInstanceId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {contentInstances.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Card>
        <Card title={t("themeAssignment")}>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            aria-label={t("themeAssignment")}
            value={device.themeId ?? ""}
            onChange={(e) => handleUpdate({ themeId: e.target.value || null })}
          >
            <option value="">— default —</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Card>
        <Card title={t("refreshProfile")}>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            aria-label={t("refreshProfile")}
            value={device.refreshProfileId ?? ""}
            onChange={(e) => handleUpdate({ refreshProfileId: e.target.value || null })}
          >
            <option value="">— default —</option>
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
          <p className="mb-4 text-sm text-gray-500">{t("remoteConfig.description")}</p>
          {canProvision && (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="https://vellum.example.com"
                  aria-label={t("remoteConfig.serverUrl")}
                  className="min-w-0 flex-1 rounded border px-3 py-2 text-sm"
                  disabled={pending || configurationApplying}
                />
                <button
                  type="button"
                  onClick={queueServerMigration}
                  disabled={pending || configurationApplying || !serverUrl.trim()}
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t("remoteConfig.migrate")}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500">{t("remoteConfig.safety")}</p>
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
                  className="min-w-0 rounded border px-3 py-2 text-sm"
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
                  className="min-w-0 rounded border px-3 py-2 text-sm"
                  disabled={pending || configurationApplying}
                />
                <button
                  type="button"
                  onClick={queueWifiConfiguration}
                  disabled={pending || configurationApplying || !wifiSsid}
                  className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t("remoteConfig.wifiChange")}
                </button>
              </div>
              <p className="mt-2 text-xs text-gray-500">{t("remoteConfig.wifiSafety")}</p>
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
                    className="flex flex-wrap items-center gap-2 rounded border p-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {command.kind === "wifi"
                        ? t("remoteConfig.wifiHistory", { ssid: payload.ssid ?? "—" })
                        : (payload.serverUrl ?? "—")}
                    </span>
                    <Badge
                      label={configurationStatus(command.status)}
                      color={
                        command.status === "applied"
                          ? "bg-green-100 text-green-800"
                          : command.status === "failed"
                            ? "bg-red-100 text-red-800"
                            : "bg-yellow-100 text-yellow-800"
                      }
                    />
                    {command.errorCode && (
                      <span className="text-xs text-red-600">
                        {configurationError(command.errorCode)}
                      </span>
                    )}
                    {isActive && canProvision && (
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
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

      {/* Telemetry History */}
      <Card title={`${t("telemetryHistory")} (${telemetryHistory.length})`}>
        {telemetryHistory.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-gray-500">
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
                    <td className="pr-4 py-1 text-gray-500">
                      {new Date(entry.timestamp).toLocaleString("de-DE")}
                    </td>
                    <td
                      className={`pr-4 py-1 ${(entry.batteryLevel ?? 100) < 20 ? "text-red-600 font-medium" : ""}`}
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
                      className={`pr-4 py-1 ${(entry.wifiRssi ?? 0) < -70 ? "text-red-600 font-medium" : ""}`}
                    >
                      {entry.wifiRssi ?? "—"} dBm
                    </td>
                    <td className="pr-4 py-1">{entry.wifiSsid ?? "—"}</td>
                    <td className="pr-4 py-1">{entry.wifiSecurity ?? "—"}</td>
                    <td className="pr-4 py-1 text-gray-500">{entry.firmwareVersion ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-gray-400">{t("noTelemetry")}</p>
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
                  <span className="text-xs text-gray-400">
                    {new Date(r.timestamp).toLocaleString("de-DE")}
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
