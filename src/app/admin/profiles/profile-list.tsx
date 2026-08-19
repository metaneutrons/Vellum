// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  createRefreshProfile,
  updateRefreshProfile,
  deleteRefreshProfile,
  setDefaultRefreshProfile,
} from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { ScheduleTimeline } from "@/components/schedule-timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  CalendarClock,
  Clock,
  ChevronUp,
  ChevronDown,
  Moon,
} from "lucide-react";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

interface Profile {
  id: string;
  name: string;
  config: unknown;
  isDefault: boolean;
}
interface ScheduleRule {
  name: string;
  days: number[];
  startHour: number;
  endHour: number;
  intervalS: number;
}

const DAY_KEYS = ["daySun", "dayMon", "dayTue", "dayWed", "dayThu", "dayFri", "daySat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
function fmtHour(h: number): string {
  return `${h.toString().padStart(2, "0")}:00`;
}

function fmtInterval(s: number): string {
  if (s >= 3600) {
    const h = s / 3600;
    return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  if (s >= 60) return `${Math.round(s / 60)}min`;
  return `${s}s`;
}

const INTERVAL_PRESETS = [
  { label: "1min", value: 60 },
  { label: "5min", value: 300 },
  { label: "15min", value: 900 },
  { label: "30min", value: 1800 },
  { label: "1h", value: 3600 },
  { label: "2h", value: 7200 },
  { label: "4h", value: 14400 },
];

const RULE_TEMPLATES: {
  labelKey: string;
  nameKey: string;
  rule: Omit<ScheduleRule, "name">;
}[] = [
  {
    labelKey: "templateNight",
    nameKey: "templateNightName",
    rule: { days: [], startHour: 22, endHour: 6, intervalS: 7200 },
  },
  {
    labelKey: "templateWeekend",
    nameKey: "templateWeekendName",
    rule: { days: WEEKEND, startHour: 0, endHour: 23, intervalS: 3600 },
  },
  {
    labelKey: "templateLunch",
    nameKey: "templateLunchName",
    rule: { days: WEEKDAYS, startHour: 12, endHour: 13, intervalS: 1800 },
  },
  {
    labelKey: "templateOffice",
    nameKey: "templateOfficeName",
    rule: { days: WEEKDAYS, startHour: 8, endHour: 18, intervalS: 300 },
  },
  {
    labelKey: "templateCustom",
    nameKey: "templateCustomName",
    rule: { days: [], startHour: 0, endHour: 23, intervalS: 900 },
  },
];

function IntervalPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTranslations("profiles");
  const [custom, setCustom] = useState(false);
  const isPreset = INTERVAL_PRESETS.some((p) => p.value === value);

  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-1">
        {INTERVAL_PRESETS.map((p) => (
          <Button
            key={p.value}
            size="sm"
            variant={value === p.value && !custom ? "filled" : "gray"}
            onClick={() => {
              onChange(p.value);
              setCustom(false);
            }}
          >
            {p.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={custom || !isPreset ? "filled" : "gray"}
          onClick={() => setCustom(true)}
        >
          {t("custom")}
        </Button>
      </div>
      {(custom || !isPreset) && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={10}
            step={10}
            className="w-24 min-h-8"
            value={value}
            onChange={(e) => onChange(parseInt(e.target.value) || 60)}
          />
          <span className="text-xs text-label-secondary">
            {t("seconds")} ({fmtInterval(value)})
          </span>
        </div>
      )}
    </div>
  );
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  const t = useTranslations("profiles");
  function toggle(day: number) {
    onChange(days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort());
  }
  const isAll = days.length === 0 || days.length === 7;
  const isWeekdays = JSON.stringify(days) === JSON.stringify(WEEKDAYS);
  const isWeekend = JSON.stringify(days) === JSON.stringify(WEEKEND);

  return (
    <div>
      <div className="flex gap-1 mb-1">
        <Button size="sm" variant={isAll ? "filled" : "gray"} onClick={() => onChange([])}>
          {t("all")}
        </Button>
        <Button
          size="sm"
          variant={isWeekdays ? "filled" : "gray"}
          onClick={() => onChange([...WEEKDAYS])}
        >
          {t("weekdays")}
        </Button>
        <Button
          size="sm"
          variant={isWeekend ? "filled" : "gray"}
          onClick={() => onChange([...WEEKEND])}
        >
          {t("weekend")}
        </Button>
      </div>
      <div className="flex gap-1">
        {DAY_KEYS.map((dayKey, i) => (
          <Button
            key={i}
            size="sm"
            variant={days.includes(i) || days.length === 0 ? "filled" : "gray"}
            onClick={() => toggle(i)}
            className="w-9 px-0"
          >
            {t(dayKey)}
          </Button>
        ))}
      </div>
    </div>
  );
}

const BASE_FIELDS: {
  key: string;
  labelKey: string;
  type: "interval" | "number" | "slider";
  unit?: string;
  min?: number;
  max?: number;
}[] = [
  { key: "usbIntervalS", labelKey: "usbInterval", type: "interval" },
  { key: "batteryIntervalS", labelKey: "batteryInterval", type: "interval" },
  { key: "lowBatteryIntervalS", labelKey: "lowBatteryInterval", type: "interval" },
  {
    key: "lowBatteryThresholdPct",
    labelKey: "lowBatteryThreshold",
    type: "slider",
    unit: "%",
    min: 5,
    max: 50,
  },
  { key: "imminentEventWindowS", labelKey: "imminentEventWindow", type: "interval" },
  { key: "wakeBeforeEventS", labelKey: "wakeBeforeEvent", type: "interval" },
];

/** Mirrors RENDER_BACKOFF_MAX_STEPS in firmware/components/sleep_manager. */
const MAX_BACKOFF_STEPS = 8;

const DEFAULT_CONFIG = {
  usbIntervalS: 60,
  batteryIntervalS: 900,
  lowBatteryIntervalS: 3600,
  lowBatteryThresholdPct: 20,
  imminentEventWindowS: 1200,
  wakeBeforeEventS: 300,
  unassignedIntervalS: 300,
  schedule: [] as ScheduleRule[],
  errorBackoffS: [60, 300, 900, 3600],
  /* The second section of the profile. 80 on USB is what the firmware did
   * unconditionally before brightness existed, so an untouched profile keeps
   * behaving as it did. */
  brightness: {
    usbPercent: 80,
    batteryPercent: 40,
    schedule: [] as BrightnessRule[],
  },
};

interface BrightnessRule {
  name: string;
  days: number[];
  startHour: number;
  endHour: number;
  percent: number;
}

export function ProfileList({ profiles }: { profiles: Profile[] }) {
  const t = useTranslations("profiles");
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>(DEFAULT_CONFIG);

  const backoff = (config.errorBackoffS ?? []) as number[];
  function setBackoff(steps: number[]) {
    setConfig((c) => ({ ...c, errorBackoffS: steps }));
  }

  const brightness = (config.brightness ?? DEFAULT_CONFIG.brightness) as {
    usbPercent: number;
    batteryPercent: number;
    schedule: BrightnessRule[];
  };
  function setBrightness(patch: Partial<typeof brightness>) {
    setConfig((c) => ({ ...c, brightness: { ...brightness, ...patch } }));
  }
  const dimRules = brightness.schedule ?? [];
  function setDimRules(rules: BrightnessRule[]) {
    setBrightness({ schedule: rules });
  }

  const schedule = (config.schedule ?? []) as ScheduleRule[];
  function setSchedule(s: ScheduleRule[]) {
    setConfig((c) => ({ ...c, schedule: s }));
  }
  function addTemplate(template: (typeof RULE_TEMPLATES)[number]) {
    setSchedule([...schedule, { ...template.rule, name: t(template.nameKey) }]);
  }
  function removeRule(i: number) {
    setSchedule(schedule.filter((_, j) => j !== i));
  }
  function updateRule(i: number, patch: Partial<ScheduleRule>) {
    setSchedule(schedule.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function moveRule(i: number, dir: -1 | 1) {
    const s = [...schedule];
    const j = i + dir;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setSchedule(s);
  }

  function startNew() {
    setEditing("new");
    setName("");
    setConfig({ ...DEFAULT_CONFIG });
  }
  function startEdit(p: Profile) {
    setEditing(p.id);
    setName(p.name);
    setConfig(p.config as Record<string, unknown>);
  }
  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createRefreshProfile(name, config);
        else if (editing) await updateRefreshProfile(editing, name, config);
        toast("success", editing === "new" ? t("created") : t("updated"));
        setEditing(null);
      } catch {
        toast("error", t("saveFailed"));
      }
    });
  }
  function handleDelete() {
    if (!deleting) return;
    const id = deleting;
    setDeleting(null);
    startTransition(async () => {
      try {
        await deleteRefreshProfile(id);
        toast("success", t("deleted"));
      } catch {
        toast("error", t("deleteFailed"));
      }
    });
  }

  function makeDefault(id: string) {
    startTransition(async () => {
      try {
        await setDefaultRefreshProfile(id);
        toast("success", t("defaultSet"));
      } catch {
        toast("error", t("defaultFailed"));
      }
    });
  }

  const filtered = profiles.filter(
    (p) => !search || p.name.toLowerCase().includes(search.toLowerCase())
  );
  const defaultProfile = profiles.find((p) => p.isDefault);

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "opacity-60 pointer-events-none" : ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">
            {t("title")}
          </h1>
          <p className="text-[15px] text-label-secondary mt-1.5">{t("description")}</p>
          {/* A profile carries cadence AND brightness now, so "refresh profile" no
              longer describes it. The table is still refresh_profiles; the drift
              between the UI term and the schema is noted in CLAUDE.md rather than
              paid for with a rename migration. */}
          <p className="text-[13px] text-label-tertiary mt-1">{t("scopeHint")}</p>
          {/* Name the inherited behaviour instead of leaving it implied: the device
            picker offers a "Default" that used to resolve to constants in the
            source, so an operator could not see what an unconfigured display did. */}
          <p className="text-[13px] text-label-tertiary mt-1">
            {defaultProfile ? t("defaultHint", { name: defaultProfile.name }) : t("noDefaultHint")}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search")}
            className="pl-9"
            aria-label={t("search")}
          />
        </div>
        <Button onClick={startNew} leading={<Plus size={16} aria-hidden="true" />}>
          {t("add")}
        </Button>
      </div>

      <div className="space-y-3">
        {filtered.map((p) => {
          const c = p.config as Record<string, unknown>;
          const rules = (c.schedule ?? []) as ScheduleRule[];
          return (
            <div
              key={p.id}
              className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden"
            >
              <div className="flex items-center gap-4 p-4">
                <div className="shrink-0 size-10 rounded-xl bg-surface-secondary border border-separator grid place-items-center text-label-secondary">
                  <CalendarClock size={18} aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold tracking-tight text-label">
                      {p.name}
                    </span>
                    {p.isDefault && <StatusPill tone="accent">{t("default")}</StatusPill>}
                    {rules.length > 0 && (
                      <StatusPill tone="accent">
                        {t("ruleCount", { count: rules.length })}
                      </StatusPill>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-label-secondary tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={14} aria-hidden="true" />
                      {t("usbSummary", { interval: fmtInterval(c.usbIntervalS as number) })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={14} aria-hidden="true" />
                      {t("batterySummary", {
                        interval: fmtInterval(c.batteryIntervalS as number),
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!p.isDefault && (
                    <Button size="sm" variant="plain" onClick={() => makeDefault(p.id)}>
                      {t("setAsDefault")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="gray"
                    onClick={() => startEdit(p)}
                    leading={<Pencil size={15} aria-hidden="true" />}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="plain"
                    aria-label={t("delete")}
                    onClick={() => setDeleting(p.id)}
                    className="text-red px-2"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <EmptyState
            icon={<CalendarClock size={24} aria-hidden="true" />}
            title={profiles.length === 0 ? t("emptyTitle") : t("noMatchesTitle")}
            description={t("emptyDescription")}
          />
        )}
      </div>

      {/* Create/edit profile editor */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("newProfile") : t("editProfile")}
        onSubmit={name ? save : undefined}
        footer={
          <>
            <Button variant="gray" onClick={() => setEditing(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={!name} loading={pending}>
              {t("save")}
            </Button>
          </>
        }
      >
        <label className="block text-sm font-medium text-label mb-1">{t("name")}</label>
        <Input
          className="mb-4"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
        />

        <h3 className="text-sm font-semibold text-label mb-3">{t("defaultIntervals")}</h3>
        <div className="space-y-3 mb-6">
          {BASE_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-medium text-label-secondary mb-1">
                {t(f.labelKey)}
              </label>
              {f.type === "interval" ? (
                <IntervalPicker
                  value={(config[f.key] as number) ?? 900}
                  onChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
                />
              ) : f.type === "slider" ? (
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={f.min}
                    max={f.max}
                    className="flex-1 accent-accent focus-ring rounded-md"
                    value={(config[f.key] as number) ?? f.min}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, [f.key]: parseInt(e.target.value) }))
                    }
                  />
                  <span className="text-sm font-medium text-label w-12 text-right">
                    {(config[f.key] as number) ?? f.min}
                    {f.unit}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={f.min}
                    max={f.max}
                    className="w-24 min-h-8"
                    value={(config[f.key] as number) ?? 0}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, [f.key]: parseInt(e.target.value) || 0 }))
                    }
                  />
                  <span className="text-xs text-label-secondary">{f.unit}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <h3 className="text-sm font-semibold text-label mb-1">{t("whileWaiting")}</h3>
        <p className="text-xs text-label-secondary mb-3">{t("whileWaitingHint")}</p>
        <div className="mb-6">
          <IntervalPicker
            value={(config.unassignedIntervalS as number) ?? 300}
            onChange={(v) => setConfig((c) => ({ ...c, unassignedIntervalS: v }))}
          />
        </div>

        <h3 className="text-sm font-semibold text-label mb-1">{t("errorRetryTitle")}</h3>
        <p className="text-xs text-label-secondary mb-3">{t("errorRetryHint")}</p>
        <div className="space-y-3 mb-6">
          {backoff.map((step, i) => (
            <div key={i}>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-label-secondary">
                  {i === backoff.length - 1 && backoff.length > 1
                    ? t("retryStepHeld", { step: i + 1 })
                    : t("retryStep", { step: i + 1 })}
                </label>
                <Button
                  size="sm"
                  variant="plain"
                  className="text-red"
                  onClick={() => setBackoff(backoff.filter((_, j) => j !== i))}
                >
                  {t("remove")}
                </Button>
              </div>
              <IntervalPicker
                value={step}
                onChange={(v) => setBackoff(backoff.map((s, j) => (j === i ? v : s)))}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="gray"
            disabled={backoff.length >= MAX_BACKOFF_STEPS}
            leading={<Plus size={14} aria-hidden="true" />}
            onClick={() =>
              setBackoff([...backoff, backoff.length ? backoff[backoff.length - 1] * 2 : 60])
            }
          >
            {t("addStep")}
          </Button>
        </div>

        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-semibold text-label">{t("scheduleRules")}</h3>
        </div>
        <p className="text-xs text-label-secondary mb-3">{t("scheduleHint")}</p>

        {/* Templates */}
        <div className="flex flex-wrap gap-1 mb-3">
          {RULE_TEMPLATES.map((template) => (
            <Button
              key={template.labelKey}
              size="sm"
              variant="gray"
              onClick={() => addTemplate(template)}
            >
              {t(template.labelKey)}
            </Button>
          ))}
        </div>

        {schedule.map((rule, i) => (
          <div key={i} className="border border-separator rounded-lg p-3 mb-3 bg-surface-secondary">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="gray"
                  aria-label={t("moveUp")}
                  onClick={() => moveRule(i, -1)}
                  disabled={i === 0}
                  className="px-1.5"
                >
                  <ChevronUp size={14} aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="gray"
                  aria-label={t("moveDown")}
                  onClick={() => moveRule(i, 1)}
                  disabled={i === schedule.length - 1}
                  className="px-1.5"
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </Button>
                <span className="inline-flex items-center gap-1 text-xs text-label-tertiary ml-1">
                  #{i + 1}
                  {rule.startHour > rule.endHour && <Moon size={13} aria-label={t("overnight")} />}
                </span>
              </div>
              <Button size="sm" variant="plain" onClick={() => removeRule(i)} className="text-red">
                {t("remove")}
              </Button>
            </div>

            <Input
              className="mb-2 min-h-9"
              placeholder={t("ruleName")}
              value={rule.name}
              onChange={(e) => updateRule(i, { name: e.target.value })}
            />

            <label className="block text-xs font-medium text-label-secondary mb-1">
              {t("days")}
            </label>
            <DayPicker days={rule.days} onChange={(days) => updateRule(i, { days })} />

            <div className="grid grid-cols-2 gap-2 mt-2 mb-2">
              <div>
                <label className="block text-xs font-medium text-label-secondary mb-1">
                  {t("from")}
                </label>
                <select
                  className={`${selectCls} w-full`}
                  value={rule.startHour}
                  onChange={(e) => updateRule(i, { startHour: parseInt(e.target.value) })}
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {fmtHour(h)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-label-secondary mb-1">
                  {t("until")}
                </label>
                <select
                  className={`${selectCls} w-full`}
                  value={rule.endHour}
                  onChange={(e) => updateRule(i, { endHour: parseInt(e.target.value) })}
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {fmtHour(h)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="block text-xs font-medium text-label-secondary mb-1">
              {t("refreshInterval")}
            </label>
            <IntervalPicker
              value={rule.intervalS}
              onChange={(v) => updateRule(i, { intervalS: v })}
            />
          </div>
        ))}

        {schedule.length === 0 && (
          <div className="text-center py-4 text-xs text-label-tertiary border border-separator rounded-lg border-dashed">
            {t("noScheduleRules")}
          </div>
        )}

        <ScheduleTimeline
          rules={schedule}
          defaultIntervalS={(config.batteryIntervalS as number) ?? 900}
        />

        {/* Brightness: the same rule shape as above, deliberately. An operator
            learns days-and-hours once and applies it to both sections. Only
            panels that report a backlight are affected; e-paper ignores it. */}
        <div className="border-t border-separator pt-4 mt-4">
          <h4 className="text-sm font-medium text-label mb-1">{t("brightness.title")}</h4>
          <p className="text-xs text-label-tertiary mb-3">{t("brightness.hint")}</p>

          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["usbPercent", "brightness.onUsb"],
                ["batteryPercent", "brightness.onBattery"],
              ] as const
            ).map(([key, labelKey]) => (
              <label key={key} className="block">
                <span className="block text-xs font-medium text-label-secondary mb-1">
                  {t(labelKey)}
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={brightness[key]}
                    onChange={(e) => setBrightness({ [key]: Number(e.target.value) })}
                    className="w-full"
                  />
                  <span className="w-10 font-mono text-xs text-label">{brightness[key]}%</span>
                </div>
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between mt-4 mb-2">
            <span className="text-xs font-medium text-label-secondary">
              {t("brightness.rules")}
            </span>
            <Button
              variant="plain"
              onClick={() =>
                setDimRules([
                  ...dimRules,
                  { name: t("brightness.night"), days: [], startHour: 22, endHour: 6, percent: 15 },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t("brightness.addRule")}
            </Button>
          </div>

          {dimRules.length === 0 ? (
            <div className="text-center py-4 text-xs text-label-tertiary border border-separator rounded-lg border-dashed">
              {t("brightness.noRules")}
            </div>
          ) : (
            <div className="space-y-2">
              {dimRules.map((rule, i) => (
                <div key={i} className="rounded-lg border border-separator p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      value={rule.name}
                      onChange={(e) =>
                        setDimRules(
                          dimRules.map((r, j) => (j === i ? { ...r, name: e.target.value } : r))
                        )
                      }
                      placeholder={t("brightness.night")}
                    />
                    <button
                      type="button"
                      aria-label={t("brightness.removeRule")}
                      onClick={() => setDimRules(dimRules.filter((_, j) => j !== i))}
                      className="focus-ring rounded p-2 text-label-tertiary hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {(["startHour", "endHour"] as const).map((field) => (
                      <label key={field} className="flex items-center gap-1.5 text-xs">
                        {t(field === "startHour" ? "from" : "until")}
                        <select
                          className={selectCls}
                          value={rule[field]}
                          onChange={(e) =>
                            setDimRules(
                              dimRules.map((r, j) =>
                                j === i ? { ...r, [field]: Number(e.target.value) } : r
                              )
                            )
                          }
                        >
                          {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>
                              {fmtHour(h)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <label className="flex flex-1 items-center gap-2 text-xs">
                      {t("brightness.level")}
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={rule.percent}
                        onChange={(e) =>
                          setDimRules(
                            dimRules.map((r, j) =>
                              j === i ? { ...r, percent: Number(e.target.value) } : r
                            )
                          )
                        }
                        className="flex-1"
                      />
                      <span className="w-10 font-mono text-label">{rule.percent}%</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={t("deleteTitle")}
        message={t("deleteMessage")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        destructive
      />
    </div>
  );
}
