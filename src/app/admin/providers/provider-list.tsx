// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { createProvider, updateProvider, deleteProvider, getProviderCredentials, testDataProvider } from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";
import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

const PROVIDER_TYPES = {
  microsoft365: {
    label: "Microsoft 365 — Calendar", category: "calendar",
    fields: [
      { key: "tenantId", label: "Tenant ID", secret: false },
      { key: "clientId", label: "Client ID", secret: false },
      { key: "clientSecret", label: "Client Secret", secret: true },
    ],
  },
  google: {
    label: "Google — Calendar", category: "calendar",
    fields: [
      { key: "clientEmail", label: "Service Account Email", secret: false },
      { key: "privateKey", label: "Private Key (PEM)", secret: true },
    ],
  },
  ical: {
    label: "iCal Feed — Calendar", category: "calendar",
    fields: [
      { key: "url", label: "iCal Feed URL", secret: false },
    ],
  },
  anny: {
    label: "anny.co — Room & Workspace Booking", category: "calendar",
    fields: [
      { key: "apiToken", label: "API Token", secret: true },
    ],
  },
} as const;

type ProviderType = keyof typeof PROVIDER_TYPES;
interface Provider { id: string; type: string; name: string; createdAt: Date; }

export function ProviderList({ providers }: { providers: Provider[] }) {
  const { toast } = useToast();
  const t = useTranslations("providers");
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [type, setType] = useState<ProviderType>("microsoft365");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string } | "loading">>({});

  function testProvider(id: string) {
    setTestResults((r) => ({ ...r, [id]: "loading" }));
    startTransition(async () => {
      const result = await testDataProvider(id);
      setTestResults((r) => ({ ...r, [id]: result }));
    });
  }

  const filteredProviders = providers.filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.type.includes(search.toLowerCase()));

  function startNew() {
    setEditing("new"); setType("microsoft365"); setName(""); setCreds({}); setVisible({});
  }

  async function startEdit(p: Provider) {
    setLoading(true); setEditing(p.id); setType(p.type as ProviderType); setName(p.name); setVisible({});
    const existing = await getProviderCredentials(p.id);
    setCreds(existing); setLoading(false);
  }

  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createProvider(type, name, creds);
        else if (editing) await updateProvider(editing, name, creds);
        toast("success", editing === "new" ? t("created") : t("updated"));
        setEditing(null);
      } catch { toast("error", t("failedSave")); }
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const id = deleting;
    setDeleting(null);
    startTransition(async () => {
      try { await deleteProvider(id); toast("success", t("deleted")); }
      catch { toast("error", t("failedDelete")); }
    });
  }

  return (
    <div>
      <PageHeader title={t("title")} description="Connect calendar and data sources" actions={<div className="flex gap-3"><SearchInput value={search} onChange={setSearch} placeholder="Search providers..." /><Button onClick={startNew}>{t("add")}</Button></div>} />

      <div className="bg-white rounded-lg shadow divide-y">
        {filteredProviders.map((p) => (
          <div key={p.id} className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                {PROVIDER_TYPES[p.type as ProviderType]?.category ?? "data"}
              </span>
              <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{p.type}</span>
            </div>
            <div className="flex gap-2 items-center">
              {(() => {
                const r = testResults[p.id];
                if (r === "loading") return <span className="text-xs text-gray-400 animate-pulse">Testing…</span>;
                if (r && r.ok) return <span className="text-xs text-green-600">✓ {r.message}</span>;
                if (r && !r.ok) return <span className="text-xs text-red-600 max-w-48 truncate" title={r.message}>✗ {r.message}</span>;
                return null;
              })()}
              <Button size="sm" variant="ghost" onClick={() => testProvider(p.id)}>{t("test")}</Button>
              <Button size="sm" variant="ghost" onClick={() => startEdit(p)}>{t("edit")}</Button>
              <Button size="sm" variant="danger" onClick={() => setDeleting(p.id)}>Delete</Button>
            </div>
          </div>
        ))}
        {filteredProviders.length === 0 && (
          <EmptyState icon={providers.length === 0 ? "⚡" : "🔍"} title={providers.length === 0 ? "No data providers" : "No providers match your search"} description={providers.length === 0 ? "Add a provider to connect calendar or other data sources." : undefined} />
        )}
      </div>

      <Modal
        open={!!editing} onSubmit={name ? save : undefined}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("addTitle") : t("editTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} disabled={!name} pending={pending}>Save</Button>
          </>
        }
      >
        {loading && <p className="text-sm text-gray-400 mb-4">Loading credentials...</p>}

        {editing === "new" && (
          <>
            <label className="block text-sm font-medium mb-1">Type</label>
            <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={type}
              onChange={(e) => { setType(e.target.value as ProviderType); setCreds({}); }}>
              {Object.entries(PROVIDER_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </>
        )}

        <label className="block text-sm font-medium mb-1">Name</label>
        <input className="w-full border rounded px-3 py-2 mb-3 text-sm" placeholder="e.g. My M365 Provider"
          value={name} onChange={(e) => setName(e.target.value)} />

        {PROVIDER_TYPES[type].fields.map((f) => (
          <div key={f.key} className="mb-3">
            <label className="block text-sm font-medium mb-1">
              {f.label}
              {editing !== "new" && <span className="text-gray-400 font-normal"> (leave blank to keep current)</span>}
            </label>
            <div className="relative">
              {f.key === "privateKey" ? (
                <textarea className="w-full border rounded px-3 py-2 text-sm font-mono h-32"
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} />
              ) : (
                <input type={f.secret && !visible[f.key] ? "password" : "text"}
                  className="w-full border rounded px-3 py-2 text-sm pr-10"
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))} />
              )}
              {f.secret && f.key !== "privateKey" && (
                <button type="button" onClick={() => setVisible((v) => ({ ...v, [f.key]: !v[f.key] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">
                  {visible[f.key] ? "🙈" : "👁"}
                </button>
              )}
            </div>
          </div>
        ))}

        {type === "ical" && (
          <p className="text-xs text-gray-500">iCal providers don&apos;t need credentials. The URL is configured per content instance.</p>
        )}
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={handleDelete}
        title={t("deleteTitle")} message={t("deleteMsg")} confirmLabel="Delete" destructive />
    </div>
  );
}
