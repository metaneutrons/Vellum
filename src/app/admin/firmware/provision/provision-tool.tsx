// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { createProvisioningVoucher } from "../../actions";
import {
  isWebSerialSupported,
  provisionOverSerial,
  scanNetworksOverSerial,
  wifiSettingsPayloadLength,
  MAX_SSID_LEN,
  MAX_PASS_LEN,
  MAX_WIFI_SETTINGS_PAYLOAD,
  MAX_PROVISIONING_UNIX_TIME,
  type ProvisionPhase,
  type ProvisionResult,
  type WifiNetwork,
} from "@/lib/provisioning/improv-serial";

// A zero-touch voucher token is 64 hex chars (32 bytes) — reserve for it when
// validating the total profile size.
const ZERO_TOUCH_TOKEN_LEN = 64;

// Server URL fits the firmware Improv buffer (256B); keep well under one byte's worth.
const MAX_URL_LEN = 255;
const MAX_NTP_SERVER_LEN = 255;

export function ProvisionTool({
  firmware,
}: {
  firmware?: { channel: "stable" | "beta"; version: string };
}) {
  const t = useTranslations("provision");
  const tx = useTranslations("provisionExtras");
  const nt = useTranslations("provisionNtp");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [ntpServer, setNtpServer] = useState("");
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ProvisionPhase | null>(null);
  const [detail, setDetail] = useState("");
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [zeroTouch, setZeroTouch] = useState(Boolean(firmware));

  useEffect(() => {
    setSupported(isWebSerialSupported());
    setServerUrl(window.location.origin);
  }, []);

  const ssidOk = ssid.trim().length > 0 && new TextEncoder().encode(ssid.trim()).length <= MAX_SSID_LEN;
  const passOk = new TextEncoder().encode(password).length <= MAX_PASS_LEN;
  const urlOk = new TextEncoder().encode(serverUrl.trim()).length <= MAX_URL_LEN;
  const ntpOk = new TextEncoder().encode(ntpServer.trim()).length <= MAX_NTP_SERVER_LEN;
  // Reserve the longest valid ten-byte UTC timestamp that can be sent. Using
  // an out-of-range ten-digit placeholder would trigger the encoder's clock
  // validation while this component is merely calculating its payload size.
  const payloadBytes = wifiSettingsPayloadLength(
    ssid.trim(),
    password,
    serverUrl.trim() || undefined,
    zeroTouch ? "x".repeat(ZERO_TOUCH_TOKEN_LEN) : undefined,
    ntpServer.trim(),
    MAX_PROVISIONING_UNIX_TIME,
  );
  const payloadOk = payloadBytes <= MAX_WIFI_SETTINGS_PAYLOAD;
  const canSubmit = supported && !busy && !scanning && ssidOk && passOk && urlOk && ntpOk && payloadOk;

  async function provision() {
    setBusy(true);
    setResult(null);
    setPhase(null);
    setDetail("");

    let deviceToken: string | undefined;
    if (zeroTouch) {
      try {
        deviceToken = await createProvisioningVoucher(`${ssid.trim() || "device"} (USB)`, firmware);
      } catch (e) {
        const message = e instanceof Error && e.message === "firmware_version_unavailable"
          ? tx("firmwarePinUnavailable")
          : e instanceof Error ? e.message : t("unknown");
        setResult({
          ok: false,
          error: message,
        });
        setBusy(false);
        return;
      }
    }

    try {
      const r = await provisionOverSerial({
        ssid: ssid.trim(),
        password,
        serverUrl: serverUrl.trim() || undefined,
        // An explicit empty fifth field clears a previously provisioned override
        // and restores the DHCP/PTB policy.
        ntpServer: ntpServer.trim(),
        provisionedAtUnix: Math.floor(Date.now() / 1000),
        deviceToken,
        onPhase: (p, d) => {
          setPhase(p);
          if (d) setDetail(d);
        },
      });
      setResult(r);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "Provisioning failed." });
    } finally {
      setBusy(false);
    }
  }

  async function doScan() {
    setScanning(true);
    setResult(null);
    try {
      const r = await scanNetworksOverSerial();
      if (r.ok) {
        setNetworks(r.networks);
        if (r.networks.length === 0) setResult({ ok: false, error: "Scan found no networks." });
      } else {
        setResult({ ok: false, error: r.error ?? "Scan failed." });
      }
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "Scan failed." });
    } finally {
      setScanning(false);
    }
  }

  return (
    <div>
      <Link href="/admin/firmware" className="text-sm text-accent hover:underline mb-4 inline-block">
        ← Back to Firmware
      </Link>
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      <Card className="p-6 max-w-lg">
        {!supported && (
          <Notice tone="orange">
            {t("unsupported")}
          </Notice>
        )}

        <div className="flex flex-col gap-4 mt-1">
          <Field
            label={t("ssid")}
            htmlFor="prov-ssid"
            hint={supported ? t("scanHint") : undefined}
            error={ssid && !ssidOk ? `Must be 1–${MAX_SSID_LEN} bytes.` : undefined}
          >
            <div className="flex gap-2">
              <Input
                id="prov-ssid"
                list="prov-networks"
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder={tx("ssidPlaceholder")}
                autoComplete="off"
                disabled={busy}
                className="flex-1"
              />
              <Button
                type="button"
                variant="gray"
                onClick={doScan}
                loading={scanning}
                disabled={!supported || busy || scanning}
              >
                {t("scan")}
              </Button>
            </div>
            <datalist id="prov-networks">
              {networks.map((n) => (
                <option key={n.ssid} value={n.ssid}>
                  {`${n.ssid} · ${n.rssi} dBm${n.secured ? "" : " · open"}`}
                </option>
              ))}
            </datalist>
          </Field>

          {networks.length > 0 && (
            <div className="rounded-xl border border-separator bg-fill-secondary p-2" aria-label={tx("networksFound", { count: networks.length })}>
              <p className="px-2 pb-2 pt-1 text-xs font-medium text-label-secondary">
                {tx("networksFound", { count: networks.length })}
              </p>
              <div className="max-h-52 overflow-y-auto">
                {networks.map((network) => (
                  <button
                    key={network.ssid}
                    type="button"
                    onClick={() => setSsid(network.ssid)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-fill-tertiary focus-ring ${ssid === network.ssid ? "bg-accent/10" : ""}`}
                    aria-pressed={ssid === network.ssid}
                  >
                    <span className="min-w-0 truncate text-sm font-medium text-label">{network.ssid}</span>
                    <span className="shrink-0 text-xs tabular-nums text-label-tertiary">
                      {network.rssi} dBm · {network.secured ? tx("secured") : tx("open")}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <Field
            label={t("password")}
            htmlFor="prov-pass"
            hint={t("openHint")}
            error={!passOk ? `Must be at most ${MAX_PASS_LEN} bytes.` : undefined}
          >
            <Input
              id="prov-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </Field>

          <Field
            label={t("serverUrl")}
            htmlFor="prov-url"
            hint={t("serverHint")}
            error={
              !urlOk
                ? `Too long (max ${MAX_URL_LEN} bytes).`
                : !payloadOk
                  ? `Profile too large for one USB frame (${payloadBytes}/${MAX_WIFI_SETTINGS_PAYLOAD} bytes) — shorten the URL.`
                  : undefined
            }
          >
            <Input
              id="prov-url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder={tx("serverPlaceholder")}
              autoComplete="off"
              disabled={busy}
            />
          </Field>

          <Field
            label={nt("label")}
            htmlFor="prov-ntp"
            hint={nt("hint")}
            error={
              !ntpOk
                ? nt("tooLong", { max: MAX_NTP_SERVER_LEN })
                : !payloadOk
                  ? nt("profileTooLarge", { current: payloadBytes, max: MAX_WIFI_SETTINGS_PAYLOAD })
                  : undefined
            }
          >
            <Input
              id="prov-ntp"
              value={ntpServer}
              onChange={(e) => setNtpServer(e.target.value)}
              placeholder={nt("placeholder")}
              autoComplete="off"
              disabled={busy}
            />
          </Field>
        </div>

        <label className="mt-4 flex items-start gap-2 cursor-pointer text-[13px] text-label-secondary">
          <input
            type="checkbox"
            checked={zeroTouch}
            onChange={(e) => setZeroTouch(e.target.checked)}
            disabled={busy}
            className="mt-0.5 size-4 rounded accent-accent focus-ring"
          />
          <span>
            <span className="font-medium text-label">{t("zeroTouch")}</span> — mint a
            one-time voucher so the device is approved automatically, skipping the manual step
            under Devices.
          </span>
        </label>

        {firmware && (
          <div className="mt-3 rounded-lg border border-accent/25 bg-accent/10 p-3 text-[13px] text-label-secondary">
            <p className="font-semibold text-label">{tx("firmwarePinTitle", { version: firmware.version })}</p>
            <p className="mt-1">{tx("firmwarePinDescription", { channel: firmware.channel, version: firmware.version })}</p>
          </div>
        )}

        <div className="mt-5">
          <Button
            size="lg"
            className="w-full"
            leading={<span aria-hidden="true">🔌</span>}
            loading={busy}
            disabled={!canSubmit}
            onClick={provision}
          >
            {busy ? t("provisioning") : t("button")}
          </Button>
        </div>

        {(phase || result) && (
          <div className="mt-4" aria-live="polite">
            {result ? (
              result.ok ? (
                <Notice tone="green">
                  <strong>{t("done")}</strong> The device joined Wi-Fi and points at the server.{" "}
                  {zeroTouch ? (
                    <>
                      It’s <strong>pre-authorized</strong> and enrolls automatically on first
                      contact — no approval needed.
                    </>
                  ) : (
                    <>
                      It will appear as <strong>pending</strong> under{" "}
                      <Link href="/admin/devices" className="underline">
                        Devices
                      </Link>{" "}
                      for approval.
                    </>
                  )}
                  {result.redirectUrl ? (
                    <>
                      {" "}
                      Device page:{" "}
                      <span className="font-mono break-all">{result.redirectUrl}</span>
                    </>
                  ) : null}
                </Notice>
              ) : (
                <Notice tone="red">
                  <strong>{t("failed")}</strong> {result.error ?? t("unknown")}
                </Notice>
              )
            ) : (
              phase && (
                <div className="p-3 rounded-lg bg-fill-secondary text-[13px] text-label-secondary flex items-center gap-2">
                  <span className="inline-block size-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
                  {tx(phase)} {detail}
                </div>
              )
            )}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2 text-[13px] text-label-secondary">
          <p className="font-medium text-label">{t("instructions")}</p>
          <ol className="list-decimal list-inside flex flex-col gap-1">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
            <li>{t("step3")}</li>
            <li>{t("step4")}</li>
          </ol>
          <p className="mt-2">
            {tx("requirements")}
          </p>
        </div>
      </Card>
    </div>
  );
}

function Notice({ tone, children }: { tone: "orange" | "red" | "green"; children: ReactNode }) {
  const tones: Record<"orange" | "red" | "green", string> = {
    orange: "bg-orange/15 text-orange",
    red: "bg-red/15 text-red",
    green: "bg-green/15 text-green",
  };
  return <div className={`mb-4 p-3 rounded-lg text-[13px] ${tones[tone]}`}>{children}</div>;
}
