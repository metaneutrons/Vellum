// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useMemo, useState, useTransition } from "react";
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
  unifiedRefreshProfileSchema,
  upgradeRefreshProfileConfig,
  type DefaultBehavior,
  type PhaseBehavior,
  type ProfileDefaults,
  type ScheduleRule,
} from "@/lib/sleep";
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  CalendarClock,
  Clock,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Moon,
  Copy,
  Settings2,
  CalendarRange,
  SlidersHorizontal,
} from "lucide-react";
import { isUsableTimezone } from "@/lib/settings/device-settings";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

interface Profile {
  id: string;
  name: string;
  config: unknown;
  isDefault: boolean;
  revision: number;
  deviceCount: number;
  siteCount: number;
}
const DAY_KEYS = ["daySun", "dayMon", "dayTue", "dayWed", "dayThu", "dayFri", "daySat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const HOURS = Array.from({ length: 96 }, (_, i) => i / 4);
function fmtHour(h: number): string {
  const hour = Math.floor(h);
  const minute = Math.round((h - hour) * 60);
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
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
    rule: {
      days: [],
      startHour: 22,
      endHour: 6,
      usb: { intervalS: 7200, brightnessPercent: 0, display: "off", device: "awake" },
      battery: { intervalS: 7200, brightnessPercent: 0, display: "off", device: "sleep" },
    },
  },
  {
    labelKey: "templateWeekend",
    nameKey: "templateWeekendName",
    rule: {
      days: WEEKEND,
      startHour: 0,
      endHour: 0,
      usb: { intervalS: 3600 },
      battery: { intervalS: 3600 },
    },
  },
  {
    labelKey: "templateLunch",
    nameKey: "templateLunchName",
    rule: {
      days: WEEKDAYS,
      startHour: 12,
      endHour: 13,
      usb: { intervalS: 1800 },
      battery: { intervalS: 1800 },
    },
  },
  {
    labelKey: "templateOffice",
    nameKey: "templateOfficeName",
    rule: {
      days: WEEKDAYS,
      startHour: 8,
      endHour: 18,
      usb: { intervalS: 300 },
      battery: { intervalS: 300 },
    },
  },
  {
    labelKey: "templateCustom",
    nameKey: "templateCustomName",
    rule: {
      days: [],
      startHour: 0,
      endHour: 0,
      usb: { intervalS: 900 },
      battery: { intervalS: 900 },
    },
  },
];

function IntervalPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useTranslations("profiles");
  const preset = INTERVAL_PRESETS.some((option) => option.value === value);
  const [custom, setCustom] = useState(!preset);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={`${selectCls} min-w-36`}
        aria-label={t("refreshInterval")}
        value={custom || !preset ? "custom" : String(value)}
        onChange={(event) => {
          if (event.target.value === "custom") {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(Number(event.target.value));
        }}
      >
        {INTERVAL_PRESETS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        <option value="custom">{t("custom")}</option>
      </select>
      {(custom || !preset) && (
        <Input
          type="number"
          min={10}
          max={604800}
          step={10}
          aria-label={t("customInterval")}
          className="w-24 min-h-8"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      {(custom || !preset) && (
        <span className="text-xs text-label-tertiary">
          {t("seconds")} · {fmtInterval(value)}
        </span>
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
        <Button
          size="sm"
          variant={isAll ? "filled" : "gray"}
          aria-pressed={isAll}
          onClick={() => onChange([])}
        >
          {t("all")}
        </Button>
        <Button
          size="sm"
          variant={isWeekdays ? "filled" : "gray"}
          aria-pressed={isWeekdays}
          onClick={() => onChange([...WEEKDAYS])}
        >
          {t("weekdays")}
        </Button>
        <Button
          size="sm"
          variant={isWeekend ? "filled" : "gray"}
          aria-pressed={isWeekend}
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
            aria-pressed={days.includes(i) || days.length === 0}
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

const POLICY_FIELDS: {
  key: string;
  labelKey: string;
  type: "interval" | "number" | "slider";
  unit?: string;
  min?: number;
  max?: number;
}[] = [
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
  version: 3 as const,
  defaults: {
    usb: { intervalS: 60, brightnessPercent: 80, display: "on", device: "awake" },
    battery: { intervalS: 900, brightnessPercent: 40, display: "on", device: "awake" },
  } satisfies ProfileDefaults,
  /* Synchronized read-compatibility fields for a deliberate server rollback. */
  usbIntervalS: 60,
  batteryIntervalS: 900,
  lowBatteryIntervalS: 3600,
  lowBatteryThresholdPct: 20,
  imminentEventWindowS: 1200,
  wakeBeforeEventS: 300,
  unassignedIntervalS: 300,
  schedule: [] as ScheduleRule[],
  errorBackoffS: [60, 300, 900, 3600],
  brightness: {
    usbPercent: 80,
    batteryPercent: 40,
    schedule: [] as [],
  },
};

export function ProfileList({ profiles, canManage }: { profiles: Profile[]; canManage: boolean }) {
  const t = useTranslations("profiles");
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [editorSection, setEditorSection] = useState<"general" | "schedule" | "advanced">(
    "general"
  );
  const [defaultSource, setDefaultSource] = useState<"usb" | "battery">("usb");
  const [ruleSource, setRuleSource] = useState<"usb" | "battery">("usb");
  const [expandedRule, setExpandedRule] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>(DEFAULT_CONFIG);
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [initialState, setInitialState] = useState("");
  const [previewTimezone, setPreviewTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );

  const validation = useMemo(() => unifiedRefreshProfileSchema.safeParse(config), [config]);
  const previewTimezoneValid = useMemo(() => isUsableTimezone(previewTimezone), [previewTimezone]);
  const currentState = JSON.stringify({ name: name.trim(), config });
  const dirty = !!editing && currentState !== initialState;

  function requestClose() {
    if (!dirty || window.confirm(t("discardConfirm"))) setEditing(null);
  }

  const backoff = (config.errorBackoffS ?? []) as number[];
  function setBackoff(steps: number[]) {
    setConfig((c) => ({ ...c, errorBackoffS: steps }));
  }

  const defaults = (config.defaults ?? DEFAULT_CONFIG.defaults) as ProfileDefaults;
  function setDefaultBehavior(source: "usb" | "battery", patch: Partial<DefaultBehavior>) {
    setConfig((current) => {
      const currentDefaults = (current.defaults ?? DEFAULT_CONFIG.defaults) as ProfileDefaults;
      const nextDefaults = {
        ...currentDefaults,
        [source]: { ...currentDefaults[source], ...patch },
      };
      const next = { ...current, defaults: nextDefaults };
      /* Keep the v1/v2 representation truthful for rollback compatibility. */
      if (patch.intervalS != null) {
        Object.assign(next, {
          [source === "usb" ? "usbIntervalS" : "batteryIntervalS"]: patch.intervalS,
        });
      }
      if (patch.brightnessPercent != null) {
        const brightness = (current.brightness ?? DEFAULT_CONFIG.brightness) as {
          usbPercent: number;
          batteryPercent: number;
          schedule: [];
        };
        Object.assign(next, {
          brightness: {
            ...brightness,
            [source === "usb" ? "usbPercent" : "batteryPercent"]: patch.brightnessPercent,
          },
        });
      }
      return next;
    });
  }
  const schedule = (config.schedule ?? []) as ScheduleRule[];
  function setSchedule(s: ScheduleRule[]) {
    setConfig((c) => ({ ...c, schedule: s }));
  }
  function addTemplate(template: (typeof RULE_TEMPLATES)[number]) {
    setSchedule([...schedule, { ...template.rule, name: t(template.nameKey) }]);
    setExpandedRule(schedule.length);
    setRuleSource("usb");
  }
  function removeRule(i: number) {
    setSchedule(schedule.filter((_, j) => j !== i));
    setExpandedRule((current) => {
      if (current == null) return null;
      if (current === i) return null;
      return current > i ? current - 1 : current;
    });
  }
  function updateRule(i: number, patch: Partial<ScheduleRule>) {
    setSchedule(schedule.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function updateBehavior(i: number, source: "usb" | "battery", patch: Partial<PhaseBehavior>) {
    setSchedule(
      schedule.map((rule, j) =>
        j === i ? { ...rule, [source]: { ...rule[source], ...patch } } : rule
      )
    );
  }
  function moveRule(i: number, dir: -1 | 1) {
    const s = [...schedule];
    const j = i + dir;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setSchedule(s);
    setExpandedRule((current) => (current === i ? j : current === j ? i : current));
  }

  function startNew() {
    setEditing("new");
    setEditorSection("general");
    setDefaultSource("usb");
    setRuleSource("usb");
    setExpandedRule(null);
    setName("");
    const fresh = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    setConfig(fresh);
    setExpectedRevision(null);
    setInitialState(JSON.stringify({ name: "", config: fresh }));
  }
  function startEdit(p: Profile) {
    setEditing(p.id);
    setEditorSection("general");
    setDefaultSource("usb");
    setRuleSource("usb");
    setExpandedRule(null);
    setName(p.name);
    const upgraded = upgradeRefreshProfileConfig(p.config) as Record<string, unknown>;
    setConfig(upgraded);
    setExpectedRevision(p.revision);
    setInitialState(JSON.stringify({ name: p.name.trim(), config: upgraded }));
  }
  function startClone(p: Profile) {
    const cloned = upgradeRefreshProfileConfig(p.config) as Record<string, unknown>;
    const clonedName = t("copyName", { name: p.name });
    setEditing("new");
    setEditorSection("general");
    setDefaultSource("usb");
    setRuleSource("usb");
    setExpandedRule(null);
    setName(clonedName);
    setConfig(cloned);
    setExpectedRevision(null);
    setInitialState(JSON.stringify({ name: clonedName.trim(), config: cloned }));
  }
  function save() {
    if (!canManage || !name.trim() || !validation.success) return;
    startTransition(async () => {
      try {
        if (editing === "new") await createRefreshProfile(name, config);
        else if (editing && expectedRevision) {
          const result = await updateRefreshProfile(editing, name, config, expectedRevision);
          if (!result.ok) {
            toast("error", t("conflict"));
            return;
          }
        }
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
  const deletingProfile = profiles.find((profile) => profile.id === deleting);
  const editingProfile = profiles.find((profile) => profile.id === editing);

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
        {canManage ? (
          <Button onClick={startNew} leading={<Plus size={16} aria-hidden="true" />}>
            {t("add")}
          </Button>
        ) : (
          <StatusPill>{t("readOnly")}</StatusPill>
        )}
      </div>

      <div className="space-y-3">
        {filtered.map((p) => {
          const c = upgradeRefreshProfileConfig(p.config);
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
                      {t("usbSummary", { interval: fmtInterval(c.defaults.usb.intervalS) })}
                    </span>
                    <span>{t("usage", { devices: p.deviceCount, sites: p.siteCount })}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={14} aria-hidden="true" />
                      {t("batterySummary", {
                        interval: fmtInterval(c.defaults.battery.intervalS),
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {canManage && !p.isDefault && (
                    <Button size="sm" variant="plain" onClick={() => makeDefault(p.id)}>
                      {t("setAsDefault")}
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      size="sm"
                      variant="plain"
                      onClick={() => startClone(p)}
                      aria-label={t("copy")}
                    >
                      <Copy size={15} aria-hidden="true" />
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      size="sm"
                      variant="gray"
                      onClick={() => startEdit(p)}
                      leading={<Pencil size={15} aria-hidden="true" />}
                    >
                      {t("edit")}
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      size="sm"
                      variant="plain"
                      aria-label={t("delete")}
                      onClick={() => setDeleting(p.id)}
                      className="text-red px-2"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  )}
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
        onClose={requestClose}
        title={editing === "new" ? t("newProfile") : t("editProfile")}
        onSubmit={name.trim() && validation.success ? save : undefined}
        wide
        footer={
          <>
            <Button variant="gray" onClick={requestClose}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={!name.trim() || !validation.success} loading={pending}>
              {t("save")}
            </Button>
          </>
        }
      >
        {!validation.success && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red/30 bg-red/10 p-3 text-xs text-red"
          >
            <p className="font-semibold">{t("invalidConfiguration")}</p>
            <ul className="mt-1 list-disc pl-4">
              {validation.error.issues.slice(0, 5).map((issue) => (
                <li key={`${issue.path.join(".")}:${issue.message}`}>
                  {t("invalidField", { field: issue.path.join(".") || "profile" })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {editingProfile && (editingProfile.deviceCount > 0 || editingProfile.siteCount > 0) && (
          <div className="mb-4 rounded-lg border border-orange/30 bg-orange/10 p-3 text-xs text-label-secondary">
            {t("saveImpact", {
              devices: editingProfile.deviceCount,
              sites: editingProfile.siteCount,
            })}
          </div>
        )}
        <nav
          className="mb-6 grid grid-cols-3 gap-1 rounded-xl bg-surface-secondary p-1"
          role="tablist"
          aria-label={t("editor.navigation")}
        >
          {(
            [
              ["general", "editor.general", Settings2],
              ["schedule", "editor.schedule", CalendarRange],
              ["advanced", "editor.advanced", SlidersHorizontal],
            ] as const
          ).map(([section, labelKey, Icon]) => (
            <button
              key={section}
              type="button"
              role="tab"
              aria-selected={editorSection === section}
              onClick={() => setEditorSection(section)}
              className={`flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-ring ${
                editorSection === section
                  ? "bg-surface text-label shadow-e1"
                  : "text-label-secondary hover:text-label"
              }`}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(labelKey)}</span>
              {section === "schedule" && schedule.length > 0 && (
                <span className="rounded-full bg-accent/15 px-1.5 text-[11px] text-accent">
                  {schedule.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        {editorSection === "general" && (
          <div role="tabpanel" className="space-y-7">
            <section>
              <label className="mb-1.5 block text-sm font-medium text-label">{t("name")}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </section>

            <section>
              <h3 className="text-base font-semibold tracking-tight text-label">
                {t("defaults.title")}
              </h3>
              <p className="mt-1 text-sm text-label-secondary">{t("defaults.hint")}</p>

              <div className="mt-4 grid grid-cols-2 gap-2" role="tablist">
                {(["usb", "battery"] as const).map((source) => {
                  const behavior = defaults[source];
                  return (
                    <button
                      key={source}
                      type="button"
                      role="tab"
                      aria-selected={defaultSource === source}
                      onClick={() => setDefaultSource(source)}
                      className={`rounded-xl border p-3 text-left transition-colors focus-ring ${
                        defaultSource === source
                          ? "border-accent bg-accent/10"
                          : "border-separator bg-surface hover:bg-surface-secondary"
                      }`}
                    >
                      <span className="block text-sm font-semibold text-label">
                        {t(source === "usb" ? "phase.usb" : "phase.battery")}
                      </span>
                      <span className="mt-1 block text-xs text-label-secondary">
                        {fmtInterval(behavior.intervalS)} · {behavior.brightnessPercent}% ·{" "}
                        {t(behavior.display === "on" ? "phase.displayOn" : "phase.displayOff")}
                      </span>
                    </button>
                  );
                })}
              </div>

              {([defaultSource] as const).map((source) => {
                const behavior = defaults[source];
                return (
                  <div
                    key={source}
                    className="mt-3 overflow-hidden rounded-2xl border border-separator bg-surface-secondary/60"
                  >
                    <div className="flex flex-col gap-2 border-b border-separator px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-medium text-label">{t("refreshInterval")}</span>
                      <IntervalPicker
                        value={behavior.intervalS}
                        onChange={(intervalS) => setDefaultBehavior(source, { intervalS })}
                      />
                    </div>
                    <label className="flex flex-col gap-3 border-b border-separator px-4 py-3 sm:flex-row sm:items-center">
                      <span className="text-sm font-medium text-label sm:w-44">
                        {t("brightness.level")}
                      </span>
                      <div className="flex flex-1 items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={behavior.brightnessPercent}
                          onChange={(event) =>
                            setDefaultBehavior(source, {
                              brightnessPercent: Number(event.target.value),
                            })
                          }
                          className="w-full"
                        />
                        <span className="w-11 text-right text-sm tabular-nums text-label">
                          {behavior.brightnessPercent}%
                        </span>
                      </div>
                    </label>
                    <label className="flex flex-col gap-2 border-b border-separator px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-medium text-label">{t("phase.display")}</span>
                      <select
                        className={`${selectCls} sm:w-72`}
                        value={behavior.display}
                        disabled={behavior.device === "sleep"}
                        onChange={(event) =>
                          setDefaultBehavior(source, {
                            display: event.target.value as "on" | "off",
                          })
                        }
                      >
                        <option value="on">{t("phase.displayOn")}</option>
                        <option value="off">{t("phase.displayOff")}</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-medium text-label">{t("phase.device")}</span>
                      <select
                        className={`${selectCls} sm:w-72`}
                        value={behavior.device}
                        onChange={(event) =>
                          setDefaultBehavior(source, {
                            device: event.target.value as "awake" | "sleep",
                            ...(event.target.value === "sleep" ? { display: "off" as const } : {}),
                          })
                        }
                      >
                        <option value="awake">{t("defaults.deviceNormal")}</option>
                        <option value="sleep">{t("defaults.deviceSleep")}</option>
                      </select>
                    </label>
                    <p className="border-t border-separator px-4 py-3 text-xs leading-relaxed text-label-tertiary">
                      {t(source === "usb" ? "defaults.usbHint" : "defaults.batteryHint")}
                    </p>
                  </div>
                );
              })}
            </section>
          </div>
        )}

        {editorSection === "schedule" && (
          <div role="tabpanel">
            <div className="mb-5">
              <h3 className="text-base font-semibold tracking-tight text-label">
                {t("scheduleRules")}
              </h3>
              <p className="mt-1 text-sm text-label-secondary">{t("scheduleHint")}</p>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
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

            <div className="space-y-2">
              {schedule.map((rule, i) => {
                const open = expandedRule === i;
                const daysLabel =
                  rule.days.length === 0 || rule.days.length === 7
                    ? t("all")
                    : JSON.stringify(rule.days) === JSON.stringify(WEEKDAYS)
                      ? t("weekdays")
                      : JSON.stringify(rule.days) === JSON.stringify(WEEKEND)
                        ? t("weekend")
                        : rule.days.map((day) => t(DAY_KEYS[day])).join(", ");
                const timeLabel =
                  rule.startHour === rule.endHour
                    ? t("allDay")
                    : `${fmtHour(rule.startHour)}–${fmtHour(rule.endHour)}`;
                const behavior = rule[ruleSource] ?? {};
                const fallback = defaults[ruleSource];
                return (
                  <div
                    key={i}
                    className="overflow-hidden rounded-xl border border-separator bg-surface"
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => {
                        setExpandedRule(open ? null : i);
                        setRuleSource("usb");
                      }}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-secondary focus-ring"
                    >
                      <ChevronRight
                        size={17}
                        className={`shrink-0 text-label-tertiary transition-transform ${open ? "rotate-90" : ""}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm font-semibold text-label">
                          <span className="truncate">
                            {rule.name || t("ruleFallback", { number: i + 1 })}
                          </span>
                          {rule.startHour > rule.endHour && (
                            <Moon size={13} aria-label={t("overnight")} />
                          )}
                        </span>
                        <span className="mt-0.5 block text-xs text-label-secondary">
                          {daysLabel} · {timeLabel}
                        </span>
                      </span>
                      <span className="text-xs tabular-nums text-label-tertiary">#{i + 1}</span>
                    </button>

                    {open && (
                      <div className="border-t border-separator bg-surface-secondary/40 p-4">
                        <div className="mb-4 flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="gray"
                              aria-label={t("moveUp")}
                              onClick={() => moveRule(i, -1)}
                              disabled={i === 0}
                              className="px-2"
                            >
                              <ChevronUp size={14} aria-hidden="true" />
                            </Button>
                            <Button
                              size="sm"
                              variant="gray"
                              aria-label={t("moveDown")}
                              onClick={() => moveRule(i, 1)}
                              disabled={i === schedule.length - 1}
                              className="px-2"
                            >
                              <ChevronDown size={14} aria-hidden="true" />
                            </Button>
                          </div>
                          <Button
                            size="sm"
                            variant="plain"
                            onClick={() => removeRule(i)}
                            className="text-red"
                          >
                            {t("remove")}
                          </Button>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-2">
                          <div className="space-y-4">
                            <label className="block">
                              <span className="mb-1 block text-xs font-medium text-label-secondary">
                                {t("ruleName")}
                              </span>
                              <Input
                                value={rule.name}
                                onChange={(e) => updateRule(i, { name: e.target.value })}
                              />
                            </label>
                            <div>
                              <label className="mb-1 block text-xs font-medium text-label-secondary">
                                {t("days")}
                              </label>
                              <DayPicker
                                days={rule.days}
                                onChange={(days) => updateRule(i, { days })}
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-label-secondary">
                                  {t("from")}
                                </span>
                                <select
                                  className={`${selectCls} w-full`}
                                  value={rule.startHour}
                                  onChange={(e) =>
                                    updateRule(i, { startHour: Number(e.target.value) })
                                  }
                                >
                                  {HOURS.map((hour) => (
                                    <option key={hour} value={hour}>
                                      {fmtHour(hour)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-label-secondary">
                                  {t("until")}
                                </span>
                                <select
                                  className={`${selectCls} w-full`}
                                  value={rule.endHour}
                                  onChange={(e) =>
                                    updateRule(i, { endHour: Number(e.target.value) })
                                  }
                                >
                                  {HOURS.map((hour) => (
                                    <option key={hour} value={hour}>
                                      {fmtHour(hour)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                          </div>

                          <div>
                            <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-surface-secondary p-1">
                              {(["usb", "battery"] as const).map((source) => (
                                <button
                                  key={source}
                                  type="button"
                                  aria-pressed={ruleSource === source}
                                  onClick={() => setRuleSource(source)}
                                  className={`rounded-md px-2 py-1.5 text-xs font-medium focus-ring ${
                                    ruleSource === source
                                      ? "bg-surface text-label shadow-e1"
                                      : "text-label-secondary"
                                  }`}
                                >
                                  {t(source === "usb" ? "phase.usb" : "phase.battery")}
                                </button>
                              ))}
                            </div>
                            <div className="space-y-3 rounded-xl border border-separator bg-surface p-3">
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-label-secondary">
                                  {t("refreshInterval")}
                                </span>
                                <IntervalPicker
                                  value={behavior.intervalS ?? fallback.intervalS}
                                  onChange={(intervalS) =>
                                    updateBehavior(i, ruleSource, { intervalS })
                                  }
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-label-secondary">
                                  {t("brightness.level")}
                                </span>
                                <div className="flex items-center gap-3">
                                  <input
                                    type="range"
                                    min={0}
                                    max={100}
                                    step={5}
                                    value={behavior.brightnessPercent ?? fallback.brightnessPercent}
                                    onChange={(e) =>
                                      updateBehavior(i, ruleSource, {
                                        brightnessPercent: Number(e.target.value),
                                      })
                                    }
                                    className="w-full"
                                  />
                                  <span className="w-11 text-right text-xs tabular-nums text-label">
                                    {behavior.brightnessPercent ?? fallback.brightnessPercent}%
                                  </span>
                                </div>
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-label-secondary">
                                  {t("phase.display")}
                                </span>
                                <select
                                  className={`${selectCls} w-full`}
                                  value={behavior.display ?? fallback.display}
                                  disabled={(behavior.device ?? fallback.device) === "sleep"}
                                  onChange={(e) =>
                                    updateBehavior(i, ruleSource, {
                                      display: e.target.value as "on" | "off",
                                    })
                                  }
                                >
                                  <option value="on">{t("phase.displayOn")}</option>
                                  <option value="off">{t("phase.displayOff")}</option>
                                </select>
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-xs font-medium text-label-secondary">
                                  {t("phase.device")}
                                </span>
                                <select
                                  className={`${selectCls} w-full`}
                                  value={behavior.device ?? fallback.device}
                                  onChange={(e) =>
                                    updateBehavior(i, ruleSource, {
                                      device: e.target.value as "awake" | "sleep",
                                      ...(e.target.value === "sleep"
                                        ? { display: "off" as const }
                                        : {}),
                                    })
                                  }
                                >
                                  <option value="awake">{t("phase.deviceAwake")}</option>
                                  <option value="sleep">{t("phase.deviceSleep")}</option>
                                </select>
                              </label>
                              {(behavior.device ?? fallback.device) === "sleep" && (
                                <p className="text-xs leading-relaxed text-label-tertiary">
                                  {t("phase.sleepHint")}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {schedule.length === 0 && (
              <div className="rounded-xl border border-dashed border-separator px-4 py-8 text-center text-sm text-label-tertiary">
                {t("noScheduleRules")}
              </div>
            )}

            <p className="mt-4 text-xs leading-relaxed text-label-tertiary">
              {t("capabilityHint")}
            </p>

            {schedule.length > 0 && (
              <label className="mt-5 block text-xs font-medium text-label-secondary">
                {t("previewTimezone")}
                <Input
                  className="mt-1"
                  value={previewTimezone}
                  onChange={(event) => setPreviewTimezone(event.target.value)}
                  placeholder="Europe/Berlin"
                  aria-invalid={!previewTimezoneValid}
                />
                {!previewTimezoneValid && (
                  <span className="mt-1 block text-red">{t("invalidTimezone")}</span>
                )}
              </label>
            )}

            <ScheduleTimeline
              rules={schedule}
              defaultUsbIntervalS={defaults.usb.intervalS}
              defaultBatteryIntervalS={defaults.battery.intervalS}
              timezone={previewTimezoneValid ? previewTimezone : "UTC"}
            />
          </div>
        )}

        {editorSection === "advanced" && (
          <div role="tabpanel" className="space-y-7">
            <section>
              <h3 className="text-base font-semibold tracking-tight text-label">
                {t("policyTitle")}
              </h3>
              <p className="mt-1 text-sm text-label-secondary">{t("policyHint")}</p>
              <div className="mt-4 divide-y divide-separator overflow-hidden rounded-xl border border-separator bg-surface-secondary/50">
                {POLICY_FIELDS.map((field) => (
                  <div
                    key={field.key}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm font-medium text-label">{t(field.labelKey)}</span>
                    {field.type === "interval" ? (
                      <IntervalPicker
                        value={(config[field.key] as number) ?? 900}
                        onChange={(value) =>
                          setConfig((current) => ({ ...current, [field.key]: value }))
                        }
                      />
                    ) : field.type === "slider" ? (
                      <div className="flex min-w-64 items-center gap-3">
                        <input
                          type="range"
                          min={field.min}
                          max={field.max}
                          className="flex-1 rounded-md accent-accent focus-ring"
                          value={(config[field.key] as number) ?? field.min}
                          onChange={(event) =>
                            setConfig((current) => ({
                              ...current,
                              [field.key]: parseInt(event.target.value),
                            }))
                          }
                        />
                        <span className="w-12 text-right text-sm tabular-nums text-label">
                          {(config[field.key] as number) ?? field.min}
                          {field.unit}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h3 className="text-base font-semibold tracking-tight text-label">
                {t("whileWaiting")}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-label-secondary">
                {t("whileWaitingHint")}
              </p>
              <div className="mt-3 inline-flex rounded-xl border border-separator bg-surface-secondary/50 p-3">
                <IntervalPicker
                  value={(config.unassignedIntervalS as number) ?? 300}
                  onChange={(value) =>
                    setConfig((current) => ({ ...current, unassignedIntervalS: value }))
                  }
                />
              </div>
            </section>

            <section>
              <h3 className="text-base font-semibold tracking-tight text-label">
                {t("errorRetryTitle")}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-label-secondary">
                {t("errorRetryHint")}
              </p>
              <div className="mt-4 divide-y divide-separator overflow-hidden rounded-xl border border-separator bg-surface-secondary/50">
                {backoff.map((step, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-sm font-medium text-label">
                      {i === backoff.length - 1 && backoff.length > 1
                        ? t("retryStepHeld", { step: i + 1 })
                        : t("retryStep", { step: i + 1 })}
                    </span>
                    <div className="flex items-center gap-2">
                      <IntervalPicker
                        value={step}
                        onChange={(value) =>
                          setBackoff(backoff.map((item, index) => (index === i ? value : item)))
                        }
                      />
                      <Button
                        size="sm"
                        variant="plain"
                        className="text-red"
                        aria-label={t("remove")}
                        onClick={() => setBackoff(backoff.filter((_, index) => index !== i))}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="gray"
                className="mt-3"
                disabled={backoff.length >= MAX_BACKOFF_STEPS}
                leading={<Plus size={14} aria-hidden="true" />}
                onClick={() =>
                  setBackoff([
                    ...backoff,
                    backoff.length ? Math.min(backoff[backoff.length - 1] * 2, 604800) : 60,
                  ])
                }
              >
                {t("addStep")}
              </Button>
            </section>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={t("deleteTitle")}
        message={
          deletingProfile
            ? t("deleteImpact", {
                devices: deletingProfile.deviceCount,
                sites: deletingProfile.siteCount,
              })
            : t("deleteMessage")
        }
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        destructive
      />
    </div>
  );
}
