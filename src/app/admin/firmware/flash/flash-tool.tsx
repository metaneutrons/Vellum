// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState } from "react";
import type { FC, ReactNode } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { DISPLAY_REGISTRY } from "@/lib/display";

// ESP Web Tools registers <esp-web-install-button> (script loaded lazily below).
// Cast the tag name to a component so it renders as a custom element with real
// React children (Aurora <Button> / <Notice> in its slots) — no JSX intrinsic
// typing or dangerouslySetInnerHTML needed.
const EspInstallButton = "esp-web-install-button" as unknown as FC<{
  manifest: string;
  children?: ReactNode;
}>;

// Native <select> styled to match the Aurora Input (no shared Select yet).
const selectCls =
  "w-full min-h-11 px-3.5 rounded-md bg-surface-secondary border border-separator " +
  "text-[15px] text-label focus-ring focus:border-accent transition";

export function FlashTool() {
  const [model, setModel] = useState("e1002");
  const [channel, setChannel] = useState("stable");
  const [loaded, setLoaded] = useState(false);

  const manifestUrl = `/api/v1/admin/flash-manifest?model=${model}&channel=${channel}`;

  useEffect(() => {
    if (loaded) return;
    const existing = document.querySelector('script[src="/install-button.js"]');
    if (existing) {
      setLoaded(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "/install-button.js";
    script.type = "module";
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, [loaded]);

  return (
    <div>
      <Link
        href="/admin/firmware"
        className="text-sm text-accent hover:underline mb-4 inline-block"
      >
        ← Back to Firmware
      </Link>
      <PageHeader title="Flash Firmware" description="Flash firmware directly from the browser via USB" />

      <Card className="p-6 max-w-lg">
        <div className="flex flex-col gap-4">
          <Field label="Display Model" htmlFor="flash-model">
            <select
              id="flash-model"
              className={selectCls}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Display model"
            >
              {Object.entries(DISPLAY_REGISTRY).map(([id, m]) => (
                <option key={id} value={id}>{m.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Channel" htmlFor="flash-channel">
            <select
              id="flash-channel"
              className={selectCls}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              aria-label="Firmware channel"
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </select>
          </Field>
        </div>

        {/* ESP Web Tools install button — full flash UX with progress. Remounted
            when model/channel change so it re-reads the manifest URL. */}
        <div key={`${model}-${channel}`} className="mt-5">
          {loaded ? (
            <EspInstallButton manifest={manifestUrl}>
              <Button
                slot="activate"
                size="lg"
                leading={<span aria-hidden="true">⚡</span>}
                className="w-full"
              >
                Connect &amp; Flash
              </Button>
              <Notice slot="unsupported" tone="orange">
                Web Serial isn’t supported in this browser. Use Chrome or Edge.
              </Notice>
              <Notice slot="not-allowed" tone="red">
                Serial port access was denied. Check your browser permissions.
              </Notice>
            </EspInstallButton>
          ) : (
            <div className="w-full min-h-12 grid place-items-center rounded-md bg-fill-tertiary text-sm text-label-secondary">
              Loading flash tools…
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-2 text-[13px] text-label-secondary">
          <p className="font-medium text-label">Instructions</p>
          <ol className="list-decimal list-inside flex flex-col gap-1">
            <li>Connect the device via USB-C cable</li>
            <li>Turn on the device (power switch on back)</li>
            <li>Click “Connect &amp; Flash” and select the serial port</li>
            <li>Wait for the flash to complete — do not disconnect</li>
          </ol>
        </div>

        <div className="mt-4 p-3 rounded-lg bg-fill-secondary text-[13px] text-label-secondary">
          <p>
            Requires <strong className="font-medium text-label">Chrome 89+</strong> or{" "}
            <strong className="font-medium text-label">Edge 89+</strong> with Web Serial API support.
          </p>
          <p className="mt-1">The firmware binary is downloaded from GitHub Releases via a local proxy.</p>
        </div>
      </Card>
    </div>
  );
}

/** Slotted status notice for the ESP Web Tools unsupported / not-allowed states. */
function Notice({
  slot,
  tone,
  children,
}: {
  slot: string;
  tone: "orange" | "red";
  children: ReactNode;
}) {
  const tones: Record<"orange" | "red", string> = {
    orange: "bg-orange/15 text-orange",
    red: "bg-red/15 text-red",
  };
  return (
    <span slot={slot}>
      <div className={`p-3 rounded-lg text-[13px] ${tones[tone]}`}>⚠ {children}</div>
    </span>
  );
}
