// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { setRollout, type RolloutOverview } from "../actions";
import { OtaEventList } from "@/components/ota-event-list";
import { useToast } from "@/components/toast";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Rocket, OctagonX, History } from "lucide-react";
import { useTranslations } from "next-intl";

type RolloutState = "full" | "canary" | "percent" | "paused" | "halted";
const STATES: RolloutState[] = ["paused", "canary", "percent", "full", "halted"];

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

interface VersionRef { version: string; channel: string; date?: string }
interface Props {
  overview: RolloutOverview;
  versions: VersionRef[];
}

/** Tone a rollout state: halted/paused = red/orange, live = green, staged = accent. */
function stateTone(s: RolloutState): "green" | "orange" | "red" {
  if (s === "halted") return "red";
  if (s === "paused") return "orange";
  return "green";
}
function RolloutRow({
  v,
  current,
  adoption,
  health,
}: {
  v: VersionRef;
  current: { state: RolloutState; percent: number };
  adoption: number;
  health: { confirmed: number; failed: number; applied: number };
}) {
  const t = useTranslations("firmware");
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const [state, setState] = useState<RolloutState>(current.state);
  const [percent, setPercent] = useState(current.percent);
  const showPct = state === "canary" || state === "percent";

  function apply(next: RolloutState, pct: number) {
    setState(next);
    setPercent(pct);
    start(async () => {
      try {
        await setRollout(v.version, v.channel, next, pct);
        toast("success", t("rolloutUpdated", { version: v.version, state: t(`state${next.charAt(0).toUpperCase()}${next.slice(1)}` as "stateFull"), percent: next === "canary" || next === "percent" ? ` ${pct}%` : "" }));
      } catch {
        toast("error", t("rolloutUpdateFailed"));
      }
    });
  }

  return (
    <div className={`px-4 py-3 flex items-center gap-4 flex-wrap ${pending ? "opacity-60" : ""}`}>
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <span className="font-mono text-[13px] text-label truncate">{v.version}</span>
        <StatusPill tone={v.channel === "stable" ? "green" : "orange"}>{v.channel}</StatusPill>
      </div>

      <div className="flex items-center gap-2 text-xs text-label-tertiary tabular-nums">
        <span title={t("rolloutAdoption")}>{t("rolloutOn", { count: adoption })}</span>
        {(health.confirmed > 0 || health.failed > 0) && (
          <span className="flex items-center gap-1.5">
            <span className="text-green">{health.confirmed}✓</span>
            {health.failed > 0 && <span className="text-red">{health.failed}✕</span>}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <StatusPill tone={stateTone(state)} dot>{t(`state${state.charAt(0).toUpperCase()}${state.slice(1)}` as "stateFull")}</StatusPill>
        <select
          className={selectCls}
          value={state}
          aria-label={t("rolloutState", { version: v.version })}
          onChange={(e) => apply(e.target.value as RolloutState, percent)}
        >
          {STATES.map((s) => (
          <option key={s} value={s}>{t(`state${s.charAt(0).toUpperCase()}${s.slice(1)}` as "stateFull")}</option>
          ))}
        </select>
        {showPct && (
          <input
            type="number"
            min={0}
            max={100}
            value={percent}
            aria-label={t("rolloutPercent", { version: v.version })}
            onChange={(e) => setPercent(Math.max(0, Math.min(100, Number(e.target.value))))}
            onBlur={() => apply(state, percent)}
            className={`${selectCls} w-16 tabular-nums`}
          />
        )}
        <Button
          size="sm"
          variant="plain"
          className="text-red px-2"
          aria-label={t("halt", { version: v.version })}
          disabled={state === "halted"}
          onClick={() => apply("halted", 0)}
        >
          <OctagonX size={15} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function RolloutPanel({ overview, versions }: Props) {
  const t = useTranslations("firmware");
  const rolloutOf = (version: string, channel: string) => {
    const r = overview.rollouts.find((x) => x.version === version && x.channel === channel);
    return { state: (r?.state as RolloutState) ?? "full", percent: r?.percent ?? 0 };
  };
  const adoptionOf = (version: string) =>
    overview.adoption.find((a) => a.version === version)?.count ?? 0;
  const healthOf = (version: string) => {
    const rows = overview.health.filter((h) => h.version === version);
    const sum = (p: string) => rows.filter((h) => h.phase === p).reduce((n, h) => n + h.count, 0);
    return {
      confirmed: sum("boot_confirmed"),
      applied: sum("applied"),
      failed: sum("verify_fail") + sum("rolled_back"),
    };
  };

  // Show the most recent handful of versions — that's where rollout control lives.
  const shown = versions.slice(0, 8);

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-3">
        <Rocket size={16} className="text-label-secondary" aria-hidden="true" />
        <h2 className="text-[15px] font-semibold text-label">{t("rollouts")}</h2>
        <span className="text-xs text-label-tertiary">
          {t("rolloutHint")}
        </span>
      </div>

      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden mb-6 divide-y divide-separator">
        {shown.length === 0 ? (
          <div className="px-4 py-6 text-sm text-label-secondary">{t("noFirmwareVersions")}</div>
        ) : (
          shown.map((v) => (
            <RolloutRow
              key={`${v.version}-${v.channel}`}
              v={v}
              current={rolloutOf(v.version, v.channel)}
              adoption={adoptionOf(v.version)}
              health={healthOf(v.version)}
            />
          ))
        )}
      </div>

      {/* Recent OTA events */}
      <div className="flex items-center gap-2 mb-3">
        <History size={16} className="text-label-secondary" aria-hidden="true" />
        <h3 className="text-[14px] font-semibold text-label">{t("recentOta")}</h3>
      </div>
      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden divide-y divide-separator">
        <OtaEventList events={overview.recentEvents} showMac />
      </div>
    </section>
  );
}
