// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { createRefreshProfile, updateRefreshProfile, deleteRefreshProfile } from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { Button as LegacyButton } from "@/components/button";
import { ScheduleTimeline } from "@/components/schedule-timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Search, Plus, Pencil, Trash2, CalendarClock, Clock } from "lucide-react";

interface Profile { id: string; name: string; config: unknown; }
interface ScheduleRule { name: string; days: number[]; startHour: number; endHour: number; intervalS: number; }

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const HOURS = Array.from({ length: 24 }, (_, i) => i);
function fmtHour(h: number): string { return `${h.toString().padStart(2, "0")}:00`; }

function fmtInterval(s: number): string {
  if (s >= 3600) { const h = s / 3600; return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`; }
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

const RULE_TEMPLATES: { label: string; rule: ScheduleRule }[] = [
  { label: "🌙 Night (22–6)", rule: { name: "Night", days: [], startHour: 22, endHour: 6, intervalS: 7200 } },
  { label: "🏖 Weekend", rule: { name: "Weekend", days: WEEKEND, startHour: 0, endHour: 23, intervalS: 3600 } },
  { label: "🍽 Lunch (12–13)", rule: { name: "Lunch Break", days: WEEKDAYS, startHour: 12, endHour: 13, intervalS: 1800 } },
  { label: "🏢 Office (8–18)", rule: { name: "Office Hours", days: WEEKDAYS, startHour: 8, endHour: 18, intervalS: 300 } },
  { label: "✏️ Custom", rule: { name: "", days: [], startHour: 0, endHour: 23, intervalS: 900 } },
];

function IntervalPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [custom, setCustom] = useState(false);
  const isPreset = INTERVAL_PRESETS.some(p => p.value === value);

  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-1">
        {INTERVAL_PRESETS.map(p => (
          <button key={p.value} type="button" onClick={() => { onChange(p.value); setCustom(false); }}
            className={`px-2 py-1 text-xs rounded ${value === p.value && !custom ? "bg-blue-600 text-white" : "border hover:bg-gray-100"}`}>
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => setCustom(true)}
          className={`px-2 py-1 text-xs rounded ${custom || !isPreset ? "bg-blue-600 text-white" : "border hover:bg-gray-100"}`}>
          Custom
        </button>
      </div>
      {(custom || !isPreset) && (
        <div className="flex items-center gap-2">
          <input type="number" min={10} step={10} className="w-24 border rounded px-2 py-1 text-sm"
            value={value} onChange={e => onChange(parseInt(e.target.value) || 60)} />
          <span className="text-xs text-gray-500">seconds ({fmtInterval(value)})</span>
        </div>
      )}
    </div>
  );
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  function toggle(day: number) {
    onChange(days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort());
  }
  const isAll = days.length === 0 || days.length === 7;
  const isWeekdays = JSON.stringify(days) === JSON.stringify(WEEKDAYS);
  const isWeekend = JSON.stringify(days) === JSON.stringify(WEEKEND);

  return (
    <div>
      <div className="flex gap-1 mb-1">
        <button type="button" onClick={() => onChange([])}
          className={`px-2 py-1 text-xs rounded ${isAll ? "bg-blue-600 text-white" : "border hover:bg-gray-100"}`}>All</button>
        <button type="button" onClick={() => onChange([...WEEKDAYS])}
          className={`px-2 py-1 text-xs rounded ${isWeekdays ? "bg-blue-600 text-white" : "border hover:bg-gray-100"}`}>Weekdays</button>
        <button type="button" onClick={() => onChange([...WEEKEND])}
          className={`px-2 py-1 text-xs rounded ${isWeekend ? "bg-blue-600 text-white" : "border hover:bg-gray-100"}`}>Weekend</button>
      </div>
      <div className="flex gap-1">
        {DAY_NAMES.map((d, i) => (
          <button key={i} type="button" onClick={() => toggle(i)}
            className={`w-9 h-8 text-xs rounded ${days.includes(i) || days.length === 0 ? "bg-blue-600 text-white" : "border hover:bg-gray-100"}`}>
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}

const BASE_FIELDS: { key: string; label: string; type: "interval" | "number" | "slider"; unit?: string; min?: number; max?: number }[] = [
  { key: "usbIntervalS", label: "USB Refresh Interval", type: "interval" },
  { key: "batteryIntervalS", label: "Battery Refresh Interval", type: "interval" },
  { key: "lowBatteryIntervalS", label: "Low Battery Interval", type: "interval" },
  { key: "lowBatteryThresholdPct", label: "Low Battery Threshold", type: "slider", unit: "%", min: 5, max: 50 },
  { key: "imminentEventWindowS", label: "Imminent Event Window", type: "interval" },
  { key: "wakeBeforeEventS", label: "Wake Before Event", type: "interval" },
];

const DEFAULT_CONFIG = {
  usbIntervalS: 60, batteryIntervalS: 900, lowBatteryIntervalS: 3600,
  lowBatteryThresholdPct: 20, imminentEventWindowS: 1200, wakeBeforeEventS: 300,
  schedule: [] as ScheduleRule[],
};

export function ProfileList({ profiles }: { profiles: Profile[] }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>(DEFAULT_CONFIG);

  const schedule = (config.schedule ?? []) as ScheduleRule[];
  function setSchedule(s: ScheduleRule[]) { setConfig(c => ({ ...c, schedule: s })); }
  function addTemplate(tpl: ScheduleRule) { setSchedule([...schedule, { ...tpl }]); }
  function removeRule(i: number) { setSchedule(schedule.filter((_, j) => j !== i)); }
  function updateRule(i: number, patch: Partial<ScheduleRule>) {
    setSchedule(schedule.map((r, j) => j === i ? { ...r, ...patch } : r));
  }
  function moveRule(i: number, dir: -1 | 1) {
    const s = [...schedule];
    const j = i + dir;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    setSchedule(s);
  }

  function startNew() { setEditing("new"); setName(""); setConfig({ ...DEFAULT_CONFIG }); }
  function startEdit(p: Profile) { setEditing(p.id); setName(p.name); setConfig(p.config as Record<string, unknown>); }
  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createRefreshProfile(name, config);
        else if (editing) await updateRefreshProfile(editing, name, config);
        toast("success", editing === "new" ? "Profile created" : "Profile updated");
        setEditing(null);
      } catch { toast("error", "Failed to save"); }
    });
  }
  function handleDelete() {
    if (!deleting) return;
    const id = deleting; setDeleting(null);
    startTransition(async () => {
      try { await deleteRefreshProfile(id); toast("success", "Deleted"); }
      catch { toast("error", "Failed to delete"); }
    });
  }

  const filtered = profiles.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "opacity-60 pointer-events-none" : ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">Refresh Profiles</h1>
          <p className="text-[15px] text-label-secondary mt-1.5">Control how often devices refresh their display</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary" aria-hidden="true" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className="pl-9" aria-label="Search..." />
        </div>
        <Button onClick={startNew} leading={<Plus size={16} aria-hidden="true" />}>New Profile</Button>
      </div>

      <div className="space-y-3">
        {filtered.map((p) => {
          const c = p.config as Record<string, unknown>;
          const rules = (c.schedule ?? []) as ScheduleRule[];
          return (
            <div key={p.id} className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                <div className="shrink-0 size-10 rounded-xl bg-surface-secondary border border-separator grid place-items-center text-label-secondary">
                  <CalendarClock size={18} aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold tracking-tight text-label">{p.name}</span>
                    {rules.length > 0 && (
                      <StatusPill tone="accent">{rules.length} rule{rules.length > 1 ? "s" : ""}</StatusPill>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-label-secondary tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={14} aria-hidden="true" />USB {fmtInterval(c.usbIntervalS as number)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock size={14} aria-hidden="true" />Battery {fmtInterval(c.batteryIntervalS as number)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button size="sm" variant="gray" onClick={() => startEdit(p)} leading={<Pencil size={15} aria-hidden="true" />}>Edit</Button>
                  <Button size="sm" variant="plain" aria-label="Delete" onClick={() => setDeleting(p.id)} className="text-red px-2"><Trash2 size={16} aria-hidden="true" /></Button>
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <EmptyState
            icon={<CalendarClock size={24} aria-hidden="true" />}
            title={profiles.length === 0 ? "No refresh profiles." : "No matching profiles."}
            description="Create profiles to control how often devices refresh."
          />
        )}
      </div>

      {/* Create/edit profile editor — out of scope this pass; keep the legacy skin. */}
      <div className="legacy-skin">
      <Modal open={!!editing} onClose={() => setEditing(null)}
        title={editing === "new" ? "New Refresh Profile" : "Edit Profile"}
        onSubmit={name ? save : undefined}
        footer={<><LegacyButton variant="ghost" onClick={() => setEditing(null)}>Cancel</LegacyButton><LegacyButton onClick={save} disabled={!name} pending={pending}>Save</LegacyButton></>}>

        <label className="block text-sm font-medium mb-1">Name</label>
        <input className="w-full border rounded px-3 py-2 mb-4 text-sm" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Office Standard" />

        <h3 className="text-sm font-semibold mb-3">Default Intervals</h3>
        <div className="space-y-3 mb-6">
          {BASE_FIELDS.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-medium mb-1">{f.label}</label>
              {f.type === "interval" ? (
                <IntervalPicker value={(config[f.key] as number) ?? 900}
                  onChange={v => setConfig(c => ({ ...c, [f.key]: v }))} />
              ) : f.type === "slider" ? (
                <div className="flex items-center gap-3">
                  <input type="range" min={f.min} max={f.max}
                    className="flex-1"
                    value={(config[f.key] as number) ?? f.min}
                    onChange={e => setConfig(c => ({ ...c, [f.key]: parseInt(e.target.value) }))} />
                  <span className="text-sm font-medium w-12 text-right">{(config[f.key] as number) ?? f.min}{f.unit}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input type="number" min={f.min} max={f.max}
                    className="w-24 border rounded px-2 py-1.5 text-sm"
                    value={(config[f.key] as number) ?? 0}
                    onChange={e => setConfig(c => ({ ...c, [f.key]: parseInt(e.target.value) || 0 }))} />
                  <span className="text-xs text-gray-500">{f.unit}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-semibold">Schedule Rules</h3>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Override the battery interval for specific days/times. Rules are checked top-to-bottom — first match wins.
        </p>

        {/* Templates */}
        <div className="flex flex-wrap gap-1 mb-3">
          {RULE_TEMPLATES.map((tpl, i) => (
            <button key={i} type="button" onClick={() => addTemplate(tpl.rule)}
              className="px-2 py-1 text-xs border rounded hover:bg-gray-100">
              {tpl.label}
            </button>
          ))}
        </div>

        {schedule.map((rule, i) => (
          <div key={i} className="border rounded-lg p-3 mb-3">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => moveRule(i, -1)} disabled={i === 0}
                  className="px-1.5 py-0.5 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">↑</button>
                <button type="button" onClick={() => moveRule(i, 1)} disabled={i === schedule.length - 1}
                  className="px-1.5 py-0.5 text-xs border rounded disabled:opacity-30 hover:bg-gray-100">↓</button>
                <span className="text-xs text-gray-400 ml-1">
                  #{i + 1}
                  {rule.startHour > rule.endHour && <span className="ml-1" title="Overnight rule (wraps past midnight)">🌙</span>}
                </span>
              </div>
              <button type="button" onClick={() => removeRule(i)} className="text-xs text-red-500 hover:underline">Remove</button>
            </div>

            <input className="w-full border rounded px-2 py-1.5 text-sm mb-2" placeholder="Rule name"
              value={rule.name} onChange={e => updateRule(i, { name: e.target.value })} />

            <label className="block text-xs font-medium mb-1">Days</label>
            <DayPicker days={rule.days} onChange={days => updateRule(i, { days })} />

            <div className="grid grid-cols-2 gap-2 mt-2 mb-2">
              <div>
                <label className="block text-xs font-medium mb-1">From</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm" value={rule.startHour}
                  onChange={e => updateRule(i, { startHour: parseInt(e.target.value) })}>
                  {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Until</label>
                <select className="w-full border rounded px-2 py-1.5 text-sm" value={rule.endHour}
                  onChange={e => updateRule(i, { endHour: parseInt(e.target.value) })}>
                  {HOURS.map(h => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
              </div>
            </div>

            <label className="block text-xs font-medium mb-1">Refresh Interval</label>
            <IntervalPicker value={rule.intervalS} onChange={v => updateRule(i, { intervalS: v })} />
          </div>
        ))}

        {schedule.length === 0 && (
          <div className="text-center py-4 text-xs text-gray-400 border rounded-lg border-dashed">
            No schedule rules. Add a template above or the default intervals will be used 24/7.
          </div>
        )}

        <ScheduleTimeline rules={schedule} defaultIntervalS={(config.batteryIntervalS as number) ?? 900} />
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={handleDelete}
        title="Delete Profile" message="Delete this refresh profile? Devices using it will fall back to defaults."
        confirmLabel="Delete" destructive />
      </div>
    </div>
  );
}
