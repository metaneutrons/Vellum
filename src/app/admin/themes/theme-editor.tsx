"use client";

import { useState, useTransition } from "react";
import { createTheme, updateTheme, deleteTheme } from "../actions";
import { useToast } from "@/components/toast";
import { ThemePreview } from "@/components/theme-preview";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import type { Theme } from "@/lib/theme";

const THEME_FIELDS: { key: keyof Theme; label: string }[] = [
  { key: "headerBg", label: "Header Background" },
  { key: "headerText", label: "Header Text" },
  { key: "freeBadge", label: "FREE Badge" },
  { key: "busyBadge", label: "BUSY Badge" },
  { key: "badgeText", label: "Badge Text" },
  { key: "background", label: "Background" },
  { key: "slotBg", label: "Event Block" },
  { key: "slotText", label: "Event Text" },
  { key: "slotSecondary", label: "Secondary Text" },
  { key: "footerText", label: "Footer Text" },
];

const DEFAULT_CONFIG: Theme = {
  name: "", headerBg: "#000000", headerText: "#FFFFFF", freeBadge: "#008000",
  busyBadge: "#FF0000", badgeText: "#FFFFFF", background: "#FFFFFF",
  slotBg: "#000000", slotText: "#FFFFFF", slotSecondary: "#000000", footerText: "#000000",
};

interface DbTheme { id: string; name: string; config: unknown; isDefault: boolean; }

export function ThemeEditor({ themes }: { themes: DbTheme[] }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const filteredThemes = themes.filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()));
  const [deleting, setDeleting] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Theme>(DEFAULT_CONFIG);

  function startEdit(t: DbTheme) { setEditing(t.id); setName(t.name); setConfig(t.config as Theme); }
  function startNew() { setEditing("new"); setName(""); setConfig(DEFAULT_CONFIG); }

  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createTheme(name, config as unknown as Record<string, string>);
        else if (editing) await updateTheme(editing, name, config as unknown as Record<string, string>);
        toast("success", editing === "new" ? "Theme created" : "Theme updated");
        setEditing(null);
      } catch { toast("error", "Failed to save theme"); }
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const id = deleting;
    setDeleting(null);
    startTransition(async () => {
      try { await deleteTheme(id); toast("success", "Theme deleted"); }
      catch { toast("error", "Failed to delete theme"); }
    });
  }

  return (
    <div>
      <PageHeader title="Themes" description="Customize display appearance" actions={<div className="flex gap-3"><SearchInput value={search} onChange={setSearch} placeholder="Search themes..." /><Button onClick={startNew}>New Theme</Button></div>} />

      <div className="bg-white rounded-lg shadow divide-y">
        {filteredThemes.map((t) => (
          <div key={t.id} className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="font-medium">{t.name}</span>
              {t.isDefault && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">default</span>}
              <div className="flex gap-1">
                {Object.values(t.config as Record<string, string>)
                  .filter((v) => typeof v === "string" && v.startsWith("#")).slice(0, 6)
                  .map((color, i) => <div key={i} className="w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: color }} />)}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => startEdit(t)}>Edit</Button>
              <Button size="sm" variant="danger" onClick={() => setDeleting(t.id)}>Delete</Button>
            </div>
          </div>
        ))}
        {filteredThemes.length === 0 && (
          <EmptyState icon={themes.length === 0 ? "◑" : "🔍"} title={themes.length === 0 ? "No themes yet" : "No themes match your search"} description={themes.length === 0 ? "Create a theme to customize the display appearance." : undefined} />
        )}
      </div>

      <Modal
        open={!!editing} onSubmit={name ? save : undefined}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New Theme" : "Edit Theme"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} disabled={!name} pending={pending}>Save</Button>
          </>
        }
      >
        <label className="block text-sm font-medium mb-1">Name</label>
        <input className="w-full border rounded px-3 py-2 mb-4 text-sm" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          {THEME_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input type="color" value={(config as unknown as Record<string, string>)[f.key] ?? "#000000"}
                onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))} className="w-8 h-8 rounded border cursor-pointer" />
              {f.label}
            </label>
          ))}
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium mb-2">Preview</label>
          <ThemePreview theme={config} />
        </div>
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={handleDelete}
        title="Delete Theme" message="Delete this theme? Devices using it will fall back to the default." confirmLabel="Delete" destructive />
    </div>
  );
}
