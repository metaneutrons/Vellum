// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import {
  AlertTriangle,
  WifiOff,
  BatteryLow,
  SignalLow,
  ImageOff,
  CheckCircle2,
  Battery,
  Wifi,
} from "lucide-react";
import { DashCard } from "./card";
import { relativeTime, shortMac, batteryTone, signalTone, ATTENTION_LABELS } from "./util";
import type { AttentionDevice } from "../dashboard-data";
import { useTranslations } from "next-intl";
import { deviceName, hasOwnName } from "@/lib/device-name";

/** Per-reason chip styling + icon, keyed to the data layer's reason strings. */
const REASON_STYLE: Record<string, { chip: string; Icon: typeof WifiOff }> = {
  offline: { chip: "bg-red/10 text-red", Icon: WifiOff },
  lowBattery: { chip: "bg-orange/10 text-orange", Icon: BatteryLow },
  weakSignal: { chip: "bg-orange/10 text-orange", Icon: SignalLow },
  noContent: { chip: "bg-accent-soft text-accent", Icon: ImageOff },
};

const TONE_TEXT: Record<"green" | "orange" | "red" | "muted", string> = {
  green: "text-green",
  orange: "text-orange",
  red: "text-red",
  muted: "text-label-tertiary",
};

export function AttentionList({ devices, now }: { devices: AttentionDevice[]; now: number }) {
  const t = useTranslations("dashboard");
  return (
    <DashCard
      title={t("needsAttention")}
      icon={<AlertTriangle size={16} />}
      action={{ label: t("allDevices"), href: "/admin/devices" }}
      flush
    >
      {devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center px-6 py-12">
          <span className="size-12 rounded-full bg-green/10 text-green grid place-items-center mb-3">
            <CheckCircle2 size={26} aria-hidden="true" />
          </span>
          <p className="text-[15px] font-semibold text-label">{t("healthy")}</p>
          <p className="text-[13px] text-label-secondary mt-1 max-w-[16rem]">
            {t("attentionHint")}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-separator">
          {devices.map((d) => {
            const bTone = batteryTone(d.batteryLevel);
            const sTone = signalTone(d.wifiRssi);
            return (
              <li
                key={d.mac}
                className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-secondary transition-colors"
              >
                {/* Identity + reasons */}
                <div className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-[13px] text-label ${hasOwnName(d) ? "" : "font-mono"}`}
                    title={d.mac}
                  >
                    {hasOwnName(d) ? deviceName(d) : shortMac(d.mac)}
                  </span>
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {d.reasons.map((reason) => {
                      const style = REASON_STYLE[reason] ?? {
                        chip: "bg-bg-secondary text-label-secondary",
                        Icon: AlertTriangle,
                      };
                      const Icon = style.Icon;
                      return (
                        <span
                          key={reason}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}
                        >
                          <Icon size={11} aria-hidden="true" />
                          {ATTENTION_LABELS[reason] ?? reason}
                        </span>
                      );
                    })}
                  </div>
                </div>

                {/* Telemetry */}
                <div className="flex flex-col items-end gap-1 shrink-0 text-xs tabular-nums">
                  <div className="flex items-center gap-2.5">
                    {d.batteryLevel !== null && (
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${TONE_TEXT[bTone]}`}
                        aria-label={`Battery ${d.batteryLevel} percent`}
                      >
                        {bTone === "red" || bTone === "orange" ? (
                          <BatteryLow size={13} aria-hidden="true" />
                        ) : (
                          <Battery size={13} aria-hidden="true" />
                        )}
                        {d.batteryLevel}%
                      </span>
                    )}
                    {d.wifiRssi !== null && (
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${TONE_TEXT[sTone]}`}
                        aria-label={`Signal ${d.wifiRssi} dBm`}
                      >
                        <Wifi size={13} aria-hidden="true" />
                        {d.wifiRssi}
                      </span>
                    )}
                  </div>
                  <span className="text-label-tertiary">{relativeTime(d.lastSeen, now)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DashCard>
  );
}
