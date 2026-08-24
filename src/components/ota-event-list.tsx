// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

/**
 * A device's firmware update history.
 *
 * Extracted from the firmware page rather than written a second time, because
 * the device detail view had NO OTA history at all and that is the most
 * operationally important thing a display can tell you: the estate held a
 * `rolled_back` with `boot_health_check` and a `verify_fail` for one wall-mounted
 * panel, and its own page said nothing about either.
 *
 * `showMac` is the only difference between the two callers. On a device's own
 * page the address is in the heading, and repeating it in every row is noise.
 */

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AlertCircle, RotateCcw } from "lucide-react";
import { retryDeviceOta } from "@/app/admin/actions";
import { useToast } from "@/components/toast";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface OtaEvent {
  mac: string;
  fromVersion: string | null;
  toVersion: string | null;
  phase: string;
  errorCode: string | null;
  timestamp: Date | string;
}

/** Red is a failure, orange a postponement, green everything that worked. */
function phaseTone(phase: string): "green" | "orange" | "red" {
  if (phase === "verify_fail" || phase === "rolled_back") return "red";
  if (phase === "deferred") return "orange";
  return "green";
}

/** A failed or rolled-back version can be offered to the device again. */
function RetryOtaButton({ mac, version }: { mac: string; version: string }) {
  const t = useTranslations("firmware");
  const { toast } = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Button
      size="sm"
      variant="plain"
      disabled={pending}
      aria-label={t("retryOta", { mac, version })}
      onClick={() =>
        start(async () => {
          try {
            await retryDeviceOta(mac, version);
            toast("success", t("retryOtaSuccess", { version }));
            router.refresh();
          } catch {
            toast("error", t("retryOtaFailed"));
          }
        })
      }
    >
      <RotateCcw size={14} aria-hidden="true" />
      {t("retryOtaShort")}
    </Button>
  );
}

export function OtaEventList({
  events,
  showMac = false,
  limit = 20,
}: {
  events: OtaEvent[];
  showMac?: boolean;
  limit?: number;
}) {
  const t = useTranslations("firmware");
  const locale = useLocale();

  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-label-secondary">
        <AlertCircle size={15} className="text-label-tertiary" aria-hidden="true" />
        {t("noOta")}
      </div>
    );
  }

  return (
    <>
      {events.slice(0, limit).map((e, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
          {showMac && (
            <span className="shrink-0 font-mono text-label-tertiary">{e.mac.slice(-8)}</span>
          )}
          <StatusPill tone={phaseTone(e.phase)} dot>
            {t(`otaPhase.${e.phase}`)}
          </StatusPill>
          <span className="truncate font-mono text-label-secondary">
            {e.fromVersion ?? "?"} → {e.toVersion ?? "?"}
          </span>
          {e.errorCode && <span className="truncate text-xs text-red">{e.errorCode}</span>}
          {(e.phase === "verify_fail" || e.phase === "rolled_back") && e.toVersion && (
            <RetryOtaButton mac={e.mac} version={e.toVersion} />
          )}
          <span className="ml-auto shrink-0 text-xs text-label-tertiary">
            {new Date(e.timestamp).toLocaleString(locale, {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      ))}
    </>
  );
}
