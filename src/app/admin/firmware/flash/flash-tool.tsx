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

interface FirmwareVersion {
  version: string;
  channel: "stable" | "beta";
  date: string;
  tag: string;
}

interface Props {
  versions: FirmwareVersion[];
}

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

export function FlashTool({ versions }: Props) {
  const t = useTranslations("flash");
  const [model, setModel] = useState("e1002");
  const [channel, setChannel] = useState("stable");
  const [version, setVersion] = useState("");
  const [loaded, setLoaded] = useState(false);

  const channelVersions = versions.filter((candidate) => candidate.channel === channel);
  const latestVersion = channelVersions[0]?.version;
  const selectedVersion = version || latestVersion;
  const selectedIsNotLatest = Boolean(version && latestVersion && version !== latestVersion);
  const manifestUrl = `/api/v1/admin/flash-manifest?model=${encodeURIComponent(model)}&channel=${encodeURIComponent(channel)}${selectedVersion ? `&version=${encodeURIComponent(selectedVersion)}` : ""}`;

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
              onChange={(e) => {
                setChannel(e.target.value);
                setVersion("");
              }}
              aria-label={t("channel")}
            >
              <option value="stable">{t("stable")}</option>
              <option value="beta">{t("beta")}</option>
            </select>
          </Field>

          <Field label={t("version")} htmlFor="flash-version">
            <select
              id="flash-version"
              className={selectCls}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              aria-label={t("version")}
              disabled={channelVersions.length === 0}
            >
              {latestVersion && <option value="">{t("latest", { version: latestVersion })}</option>}
              {channelVersions.map((candidate) => (
                <option key={candidate.tag} value={candidate.version}>
                  {`v${candidate.version} · ${new Date(candidate.date).toLocaleDateString()}`}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {selectedIsNotLatest && selectedVersion && latestVersion && (
          <div className="mt-5 rounded-xl border border-orange/30 bg-orange/10 px-4 py-3 text-[13px] text-label-secondary">
            <p className="font-semibold text-label">{t("nonLatestTitle")}</p>
            <p className="mt-1">{t("nonLatestDescription", { version: selectedVersion, latest: latestVersion })}</p>
            <Link href="/admin/devices" className="mt-2 inline-block font-medium text-accent hover:underline focus-ring rounded">
              {t("openDevices")}
            </Link>
          </div>
        )}

        {/* ESP Web Tools install button — full flash UX with progress. Remounted
            when model/channel change so it re-reads the manifest URL. */}
        <div key={`${model}-${channel}-${selectedVersion ?? "none"}`} className="mt-5">
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

        <section className="mt-6 rounded-xl border border-separator bg-fill-secondary p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-on-accent">2</span>
            <div>
              <h2 className="text-sm font-semibold text-label">{t("nextStepTitle")}</h2>
              <p className="mt-1 text-[13px] leading-5 text-label-secondary">{t("nextStepDescription")}</p>
            </div>
          </div>
          <Link
            href="/admin/firmware/provision"
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-fill-tertiary px-4 text-[15px] font-semibold text-label transition hover:bg-fill-secondary focus-ring active:scale-[0.97]"
          >
            {t("continueProvisioning")} <span aria-hidden="true">→</span>
          </Link>
        </section>
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
