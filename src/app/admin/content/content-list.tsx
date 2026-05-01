// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition, useEffect } from "react";
import { useTranslations } from "next-intl";
import { createContentInstance, updateContentInstance, deleteContentInstance, testContentInstance } from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

interface ContentInstance { id: string; typeSlug: string; name: string; config: unknown; }
interface ContentType { slug: string; name: string; description?: string | null; }
interface Provider { id: string; type: string; name: string; }
interface Props { instances: ContentInstance[]; types: ContentType[]; providers: Provider[]; knownDisplays: DisplaySize[]; initialEditId?: string | null; }

import { AnnyResourcePicker } from "@/components/anny-resource-picker";
import { DoorSignEditor } from "@/components/door-sign-editor";
import type { Design, DisplaySize } from "@/lib/content/renderers/door-sign-types";
import { ROOM_POLICIES } from "@/lib/content/renderers/room-booking-types";

function DoorSignConfigEditor({ config, onChange, providers, knownDisplays }: {
  config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void; providers: Provider[]; knownDisplays: DisplaySize[];
}) {
  const t = useTranslations("content");
  const td = useTranslations("content.doorSign");
  const design = (config.design ?? { backgroundAssetId: null, textBoxes: [], freeTextBoxes: [], backgroundColor: "#FFFFFF" }) as Design;
  const designOverrides = (config.designOverrides ?? {}) as Record<string, Design>;

  return (
    <>
      <label className="block text-sm font-medium mb-1">{t("provider")}</label>
      <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.providerId as string) ?? ""}
        onChange={(e) => onChange({ ...config, providerId: e.target.value })}>
        <option value="">— select —</option>
        {providers.filter(p => p.type === "anny").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      {config.providerId && (
        <>
          <label className="block text-sm font-medium mb-1">{td("resource")}</label>
          <div className="mb-3">
            <AnnyResourcePicker
              providerId={config.providerId as string}
              resourceId={(config.resourceId as string) ?? ""}
              resourceName={config.resourceName as string | undefined}
              onChange={(resId, resName) => onChange({ ...config, resourceId: resId, resourceName: resName })}
            />
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-sm font-medium mb-1">Timezone</label>
          <input className="w-full border rounded px-3 py-2 text-sm" placeholder="Europe/Berlin"
            value={(config.timezone as string) ?? "Europe/Berlin"} onChange={(e) => onChange({ ...config, timezone: e.target.value })} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Locale</label>
          <select className="w-full border rounded px-3 py-2 text-sm" value={(config.locale as string) ?? "de"}
            onChange={(e) => onChange({ ...config, locale: e.target.value })}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
            <option value="fr">Français</option>
            <option value="it">Italiano</option>
            <option value="es">Español</option>
          </select>
        </div>
      </div>

      {/* Custom Properties — manual key-value pairs for template variables */}
      <div className="border-t pt-3 mt-3">
        <label className="block text-sm font-semibold mb-1">{td("customProperties")}</label>
        <p className="text-xs text-gray-500 mb-2">{td("customPropertiesHint")}</p>
        {Object.entries((config.cachedProperties as Record<string, string>) ?? {}).map(([key, val]) => (
          <div key={key} className="flex gap-2 mb-1">
            <input className="flex-1 border rounded px-2 py-1 text-sm" value={key} readOnly />
            <input className="flex-1 border rounded px-2 py-1 text-sm" value={val}
              onChange={(e) => onChange({ ...config, cachedProperties: { ...(config.cachedProperties as Record<string, string>), [key]: e.target.value } })} />
            <button className="text-red-500 text-sm px-1" onClick={() => {
              const { [key]: _, ...rest } = (config.cachedProperties as Record<string, string>) ?? {};
              onChange({ ...config, cachedProperties: rest });
            }}>×</button>
          </div>
        ))}
        <div className="flex gap-2 mt-1">
          <input id="newPropKey" className="flex-1 border rounded px-2 py-1 text-sm" placeholder="prop.Raumnummer" />
          <input id="newPropVal" className="flex-1 border rounded px-2 py-1 text-sm" placeholder="1J.2.02" />
          <button className="text-blue-600 text-sm font-medium px-2" onClick={() => {
            const keyEl = document.getElementById("newPropKey") as HTMLInputElement;
            const valEl = document.getElementById("newPropVal") as HTMLInputElement;
            if (keyEl.value && valEl.value) {
              onChange({ ...config, cachedProperties: { ...(config.cachedProperties as Record<string, string>), [keyEl.value]: valEl.value } });
              keyEl.value = ""; valEl.value = "";
            }
          }}>+ Add</button>
        </div>
      </div>

      <div className="border-t pt-3 mt-3">
        <label className="block text-sm font-semibold mb-2">{td("visualLayout")}</label>
        <DoorSignEditor
          design={design}
          designOverrides={designOverrides}
          onChange={(d, o) => onChange({ ...config, design: d, designOverrides: o })}
          knownDisplays={knownDisplays}
          providerId={config.providerId as string}
          resourceId={config.resourceId as string}
          onPropertiesResolved={(props) => onChange({ ...config, cachedProperties: props })}
        />
      </div>
    </>
  );
}

function RoomBookingEditor({ config, onChange, providers }: {
  config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void; providers: Provider[];
}) {
  const t = useTranslations("content");
  const roomConfig = (config.roomConfig ?? {}) as Record<string, string>;
  const provider = providers.find((p) => p.id === config.providerId);

  const isAnny = provider?.type === "anny";
  const fieldConfig = provider?.type === "google"
    ? { label: "Calendar ID", placeholder: "calendar-id@group.calendar.google.com", key: "calendarId" }
    : provider?.type === "anny"
    ? { label: "Resource", placeholder: "", key: "resourceId" }
    : provider?.type === "ical"
    ? null  /* iCal URL is in provider credentials, not room config */
    : { label: "Room Mailbox Email", placeholder: "room@company.com", key: "roomEmail" };

  return (
    <>
      <label className="block text-sm font-medium mb-1">{t("provider")}</label>
      <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.providerId as string) ?? ""}
        onChange={(e) => onChange({ ...config, providerId: e.target.value })}>
        <option value="">— select —</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
      </select>

      <label className="block text-sm font-medium mb-1">Room Display Name</label>
      <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="e.g. Besprechungsraum EG"
        value={(config.roomName as string) ?? ""} onChange={(e) => onChange({ ...config, roomName: e.target.value })} />

      <label className="block text-sm font-medium mb-1">{fieldConfig?.label ?? ""}</label>
      {isAnny && config.providerId ? (
        <div className="mb-3">
          <AnnyResourcePicker
            providerId={config.providerId as string}
            resourceId={roomConfig.resourceId ?? ""}
            resourceName={roomConfig.resourceName}
            onChange={(resId, resName) => onChange({
              ...config,
              roomConfig: { resourceId: resId, resourceName: resName },
              roomName: (config.roomName as string) || resName,
            })}
          />
        </div>
      ) : fieldConfig ? (
        <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder={fieldConfig.placeholder}
          value={roomConfig[fieldConfig.key] ?? ""}
          onChange={(e) => onChange({ ...config, roomConfig: { [fieldConfig.key]: e.target.value } })} />
      ) : <div className="mb-3" /> }

      <label className="block text-sm font-medium mb-1">Timezone</label>
      <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="Europe/Berlin"
        value={(config.timezone as string) ?? "UTC"} onChange={(e) => onChange({ ...config, timezone: e.target.value })} />

      <label className="block text-sm font-medium mb-1">Display Language</label>
      <select className="w-full border rounded px-3 py-2 mb-3 text-sm"
        value={(config.locale as string) ?? "en"}
        onChange={(e) => onChange({ ...config, locale: e.target.value })}>
        <option value="en">English</option>
        <option value="de">Deutsch</option>
        <option value="fr">Français</option>
        <option value="it">Italiano</option>
        <option value="es">Español</option>
      </select>

      <label className="block text-sm font-medium mb-1">Privacy Policy</label>
      <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.policy as string) ?? "Show All"}
        onChange={(e) => onChange({ ...config, policy: e.target.value })}>
        {ROOM_POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>

      <label className="block text-sm font-medium mb-1">Cache TTL (seconds)</label>
      <input type="number" className="w-full border rounded px-3 py-2 mb-3 text-sm" min={0} step={30}
        placeholder="120"
        value={(config.cacheTtlS as number) ?? 120}
        onChange={(e) => onChange({ ...config, cacheTtlS: parseInt(e.target.value) || 120 })} />
    </>
  );
}

export function ContentList({ instances, types, providers, knownDisplays, initialEditId }: Props) {
  const { toast } = useToast();
  const tc = useTranslations("contentTypes");
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(initialEditId ?? null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [typeSlug, setTypeSlug] = useState("room-booking");
  const [search, setSearch] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string } | "loading">>({});
  const filteredInstances = instances.filter((inst) => !search || inst.name.toLowerCase().includes(search.toLowerCase()) || inst.typeSlug.includes(search.toLowerCase()));
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});

  function startNew() {
    setEditing("new"); setTypeSlug("room-booking"); setName("");
    setConfig({ timezone: "Europe/Berlin", policy: "Show All" });
  }

  function startEdit(inst: ContentInstance) {
    setEditing(inst.id); setTypeSlug(inst.typeSlug); setName(inst.name);
    setConfig(inst.config as Record<string, unknown>);
  }

  // Auto-open editor when navigated from device table
  useEffect(() => {
    if (initialEditId) {
      const inst = instances.find(i => i.id === initialEditId);
      if (inst) startEdit(inst);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createContentInstance(typeSlug, name, config);
        else if (editing) await updateContentInstance(editing, name, config);
        toast("success", editing === "new" ? "Content created" : "Content updated");
        setEditing(null);
      } catch { toast("error", "Failed to save content"); }
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const id = deleting;
    setDeleting(null);
    startTransition(async () => {
      try { await deleteContentInstance(id); toast("success", "Content deleted"); }
      catch { toast("error", "Failed to delete content"); }
    });
  }

  return (
    <div>
      <PageHeader title="Content Instances" description="Configure what each display shows" actions={<div className="flex gap-3"><SearchInput value={search} onChange={setSearch} placeholder="Search content..." /><Button onClick={startNew}>New Content</Button></div>} />

      <div className="bg-white rounded-lg shadow divide-y">
        {filteredInstances.map((inst) => (
          <div key={inst.id} className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{inst.name}</span>
              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                {tc(inst.typeSlug as "room-booking" | "door-sign")}
              </span>
            </div>
            <div className="flex gap-2">
              {(() => {
                const r = testResults[inst.id];
                if (r === "loading") return <span className="text-xs text-gray-400 animate-pulse">Testing…</span>;
                if (r && r.ok) return <span className="text-xs text-green-600">✓ {r.message}</span>;
                if (r && !r.ok) return <span className="text-xs text-red-600 max-w-48 truncate" title={r.message}>✗ {r.message}</span>;
                return null;
              })()}
              <Button size="sm" variant="ghost" onClick={() => { setTestResults((s) => ({ ...s, [inst.id]: "loading" })); startTransition(async () => { const res = await testContentInstance(inst.id); setTestResults((s) => ({ ...s, [inst.id]: res })); }); }}>Test</Button>
              <Button size="sm" variant="ghost" onClick={() => setPreviewing(inst.id)}>Preview</Button>
              <Button size="sm" variant="ghost" onClick={() => startEdit(inst)}>Edit</Button>
              <Button size="sm" variant="danger" onClick={() => setDeleting(inst.id)}>Delete</Button>
            </div>
          </div>
        ))}
        {filteredInstances.length === 0 && (
          <EmptyState icon={instances.length === 0 ? "▤" : "🔍"} title={instances.length === 0 ? "No content instances" : "No content matches your search"} description={instances.length === 0 ? "Create one and assign it to a device to display content." : undefined} />
        )}
      </div>

      <Modal
        open={!!editing} onSubmit={name ? save : undefined}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New Content Instance" : "Edit Content"}
        wide={typeSlug === "door-sign"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} disabled={!name} pending={pending}>Save</Button>
          </>
        }
      >
        {editing === "new" && (
          <>
            <label className="block text-sm font-medium mb-1">Content Type</label>
            <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={typeSlug}
              onChange={(e) => setTypeSlug(e.target.value)}>
              {types.map((t) => <option key={t.slug} value={t.slug}>{tc(t.slug as "room-booking" | "door-sign")}</option>)}
            </select>
          </>
        )}

        <label className="block text-sm font-medium mb-1">Name</label>
        <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="e.g. Besprechungsraum EG"
          value={name} onChange={(e) => setName(e.target.value)} />

        {typeSlug === "room-booking" && (
          <RoomBookingEditor config={config} onChange={setConfig} providers={providers} />
        )}
        {typeSlug === "door-sign" && (
          <DoorSignConfigEditor config={config} onChange={setConfig} providers={providers} knownDisplays={knownDisplays} />
        )}
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={handleDelete}
        title="Delete Content" message="Delete this content instance? Devices using it will show no content." confirmLabel="Delete" destructive />

      <Modal open={!!previewing} onClose={() => setPreviewing(null)} title="Content Preview">
        {previewing && (
          <img
            src={`/api/v1/admin/preview?instanceId=${previewing}&t=${Date.now()}`}
            alt="Content preview"
            className="w-full rounded border"
          />
        )}
      </Modal>
    </div>
  );
}
