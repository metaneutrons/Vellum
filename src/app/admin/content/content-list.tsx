"use client";

import { useState, useTransition } from "react";
import { createContentInstance, updateContentInstance, deleteContentInstance } from "../actions";
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
interface Props { instances: ContentInstance[]; types: ContentType[]; providers: Provider[]; }

const POLICIES = ["Show All", "Hide Subject", "Hide All"] as const;

function RoomBookingEditor({ config, onChange, providers }: {
  config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void; providers: Provider[];
}) {
  const roomConfig = (config.roomConfig ?? {}) as Record<string, string>;
  const provider = providers.find((p) => p.id === config.providerId);
  const fieldConfig = provider?.type === "google"
    ? { label: "Calendar ID", placeholder: "calendar-id@group.calendar.google.com", key: "calendarId" }
    : provider?.type === "ical"
    ? { label: "iCal Feed URL", placeholder: "https://example.com/calendar.ics", key: "icalUrl" }
    : { label: "Room Mailbox Email", placeholder: "room@company.com", key: "roomEmail" };

  return (
    <>
      <label className="block text-sm font-medium mb-1">Calendar Provider</label>
      <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.providerId as string) ?? ""}
        onChange={(e) => onChange({ ...config, providerId: e.target.value })}>
        <option value="">— select —</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
      </select>

      <label className="block text-sm font-medium mb-1">Room Display Name</label>
      <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="e.g. Besprechungsraum EG"
        value={(config.roomName as string) ?? ""} onChange={(e) => onChange({ ...config, roomName: e.target.value })} />

      <label className="block text-sm font-medium mb-1">{fieldConfig.label}</label>
      <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder={fieldConfig.placeholder}
        value={roomConfig[fieldConfig.key] ?? ""}
        onChange={(e) => onChange({ ...config, roomConfig: { [fieldConfig.key]: e.target.value } })} />

      <label className="block text-sm font-medium mb-1">Timezone</label>
      <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="Europe/Berlin"
        value={(config.timezone as string) ?? "UTC"} onChange={(e) => onChange({ ...config, timezone: e.target.value })} />

      <label className="block text-sm font-medium mb-1">Privacy Policy</label>
      <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.policy as string) ?? "Show All"}
        onChange={(e) => onChange({ ...config, policy: e.target.value })}>
        {POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>

      <label className="block text-sm font-medium mb-1">Cache TTL (seconds)</label>
      <input type="number" className="w-full border rounded px-3 py-2 mb-3 text-sm" min={0} step={30}
        placeholder="120"
        value={(config.cacheTtlS as number) ?? 120}
        onChange={(e) => onChange({ ...config, cacheTtlS: parseInt(e.target.value) || 120 })} />
    </>
  );
}

export function ContentList({ instances, types, providers }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [typeSlug, setTypeSlug] = useState("room-booking");
  const [search, setSearch] = useState("");
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
                {types.find((t) => t.slug === inst.typeSlug)?.name ?? inst.typeSlug}
              </span>
            </div>
            <div className="flex gap-2">
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
              {types.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
            </select>
          </>
        )}

        <label className="block text-sm font-medium mb-1">Name</label>
        <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="e.g. Besprechungsraum EG"
          value={name} onChange={(e) => setName(e.target.value)} />

        {typeSlug === "room-booking" && (
          <RoomBookingEditor config={config} onChange={setConfig} providers={providers} />
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
