// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  isWebSerialSupported,
  provisionOverSerial,
  MAX_SSID_LEN,
  MAX_PASS_LEN,
  type ProvisionPhase,
  type ProvisionResult,
} from "@/lib/provisioning/improv-serial";

const PHASE_TEXT: Record<ProvisionPhase, string> = {
  connecting: "Opening serial port…",
  sending: "Sending profile to the device…",
  provisioning: "Device is joining Wi-Fi…",
  provisioned: "Device joined Wi-Fi.",
  error: "Provisioning failed.",
};

// Server URL fits the firmware Improv buffer (256B); keep well under one byte's worth.
const MAX_URL_LEN = 255;

export function ProvisionTool() {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ProvisionPhase | null>(null);
  const [detail, setDetail] = useState("");
  const [result, setResult] = useState<ProvisionResult | null>(null);

  useEffect(() => {
    setSupported(isWebSerialSupported());
    setServerUrl(window.location.origin);
  }, []);

  const ssidOk = ssid.trim().length > 0 && new TextEncoder().encode(ssid.trim()).length <= MAX_SSID_LEN;
  const passOk = new TextEncoder().encode(password).length <= MAX_PASS_LEN;
  const urlOk = new TextEncoder().encode(serverUrl.trim()).length <= MAX_URL_LEN;
  const canSubmit = supported && !busy && ssidOk && passOk && urlOk;

  async function provision() {
    setBusy(true);
    setResult(null);
    setPhase(null);
    setDetail("");
    const r = await provisionOverSerial({
      ssid: ssid.trim(),
      password,
      serverUrl: serverUrl.trim() || undefined,
      onPhase: (p, d) => {
        setPhase(p);
        if (d) setDetail(d);
      },
    });
    setResult(r);
    setBusy(false);
  }

  return (
    <div>
      <Link href="/admin/firmware" className="text-sm text-accent hover:underline mb-4 inline-block">
        ← Back to Firmware
      </Link>
      <PageHeader
        title="Provision over USB"
        description="Push Wi-Fi and the server URL to a device over the USB cable — no SoftAP setup."
      />

      <Card className="p-6 max-w-lg">
        {!supported && (
          <Notice tone="orange">
            Web Serial isn’t available in this browser. Use <strong>Chrome</strong> or{" "}
            <strong>Edge</strong> on desktop, over HTTPS or localhost.
          </Notice>
        )}

        <div className="flex flex-col gap-4 mt-1">
          <Field
            label="Wi-Fi network (SSID)"
            htmlFor="prov-ssid"
            error={ssid && !ssidOk ? `Must be 1–${MAX_SSID_LEN} bytes.` : undefined}
          >
            <Input
              id="prov-ssid"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="e.g. OfficeWiFi"
              autoComplete="off"
              disabled={busy}
            />
          </Field>

          <Field
            label="Wi-Fi password"
            htmlFor="prov-pass"
            hint="Leave empty for an open network."
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
            label="Server URL"
            htmlFor="prov-url"
            hint="Where the device reports in. Prefilled from this admin’s address."
            error={!urlOk ? `Too long (max ${MAX_URL_LEN} bytes).` : undefined}
          >
            <Input
              id="prov-url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://vellum.example.com"
              autoComplete="off"
              disabled={busy}
            />
          </Field>
        </div>

        <div className="mt-5">
          <Button
            size="lg"
            className="w-full"
            leading={<span aria-hidden="true">🔌</span>}
            loading={busy}
            disabled={!canSubmit}
            onClick={provision}
          >
            {busy ? "Provisioning…" : "Provision over USB"}
          </Button>
        </div>

        {(phase || result) && (
          <div className="mt-4" aria-live="polite">
            {result ? (
              result.ok ? (
                <Notice tone="green">
                  <strong>Done.</strong> The device joined Wi-Fi and points at the server. It will
                  appear as <strong>pending</strong> under{" "}
                  <Link href="/admin/devices" className="underline">
                    Devices
                  </Link>{" "}
                  for approval.
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
                  <strong>Failed.</strong> {result.error ?? "Unknown error."}
                </Notice>
              )
            ) : (
              phase && (
                <div className="p-3 rounded-lg bg-fill-secondary text-[13px] text-label-secondary flex items-center gap-2">
                  <span className="inline-block size-2 rounded-full bg-accent animate-pulse" aria-hidden="true" />
                  {PHASE_TEXT[phase]} {detail}
                </div>
              )
            )}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-2 text-[13px] text-label-secondary">
          <p className="font-medium text-label">Instructions</p>
          <ol className="list-decimal list-inside flex flex-col gap-1">
            <li>Connect the device via USB-C and power it on.</li>
            <li>Enter the Wi-Fi details (the server URL is prefilled).</li>
            <li>Click “Provision over USB” and pick the device’s serial port.</li>
            <li>Wait for “Device joined Wi-Fi”, then approve it under Devices.</li>
          </ol>
          <p className="mt-2">
            Requires <strong className="font-medium text-label">Chrome/Edge 89+</strong> with Web
            Serial. Credentials travel over the USB cable only — nothing is broadcast.
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
