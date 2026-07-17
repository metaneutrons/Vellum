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
import { useTranslations } from "next-intl";

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
  const t = useTranslations("flash");
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
        {t("back")}
      </Link>
      <PageHeader title={t("title")} description={t("description")} />

      <Card className="p-6 max-w-lg">
        <div className="flex flex-col gap-4">
          <Field label={t("model")} htmlFor="flash-model">
            <select
              id="flash-model"
              className={selectCls}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label={t("model")}
            >
              {Object.entries(DISPLAY_REGISTRY).map(([id, m]) => (
                <option key={id} value={id}>{m.name}</option>
              ))}
            </select>
          </Field>

          <Field label={t("channel")} htmlFor="flash-channel">
            <select
              id="flash-channel"
              className={selectCls}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              aria-label={t("channel")}
            >
              <option value="stable">{t("stable")}</option>
              <option value="beta">{t("beta")}</option>
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
                {t("connect")}
              </Button>
              <Notice slot="unsupported" tone="orange">
                {t("unsupported")}
              </Notice>
              <Notice slot="not-allowed" tone="red">
                {t("denied")}
              </Notice>
            </EspInstallButton>
          ) : (
            <div className="w-full min-h-12 grid place-items-center rounded-md bg-fill-tertiary text-sm text-label-secondary">
              {t("loading")}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-2 text-[13px] text-label-secondary">
          <p className="font-medium text-label">{t("instructions.title")}</p>
          <ol className="list-decimal list-inside flex flex-col gap-1">
            <li>{t("instructions.step1")}</li>
            <li>{t("instructions.step2")}</li>
            <li>{t("instructions.step3")}</li>
            <li>{t("instructions.step4")}</li>
          </ol>
        </div>

        <div className="mt-4 p-3 rounded-lg bg-fill-secondary text-[13px] text-label-secondary">
          <p>
            {t("requirements")}
          </p>
          <p className="mt-1">{t("proxy")}</p>
        </div>

        <div className="mt-4 text-[13px]">
          <Link href="/admin/firmware/provision" className="text-accent hover:underline">
            Next: provision Wi-Fi &amp; server over USB →
          </Link>
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
