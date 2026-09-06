// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import {
  createProvider,
  updateProvider,
  deleteProvider,
  getProviderCredentials,
  testDataProvider,
} from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Plus, Search, X, Check, Loader2, Plug, Eye, EyeOff } from "lucide-react";

const PROVIDER_TYPES = {
  microsoft365: {
    label: "Microsoft 365 — Calendar",
    category: "calendar",
    fields: [
      { key: "tenantId", labelKey: "fieldTenantId", secret: false },
      { key: "clientId", labelKey: "fieldClientId", secret: false },
      { key: "clientSecret", labelKey: "fieldClientSecret", secret: true },
    ],
  },
  google: {
    label: "Google — Calendar",
    category: "calendar",
    fields: [
      { key: "clientEmail", labelKey: "fieldServiceAccountEmail", secret: false },
      { key: "privateKey", labelKey: "fieldPrivateKey", secret: true },
    ],
  },
  ical: {
    label: "iCal Feed — Calendar",
    category: "calendar",
    fields: [{ key: "url", labelKey: "fieldIcalUrl", secret: false }],
  },
  anny: {
    label: "anny.co — Room & Workspace Booking",
    category: "calendar",
    fields: [{ key: "apiToken", labelKey: "fieldApiToken", secret: true }],
  },
} as const;

type ProviderType = keyof typeof PROVIDER_TYPES;

/* A stored provider row can carry a type this build no longer knows, so looking
 * one up by plain string may miss. Widening the literal map states that; casting
 * the row's own type into the union would claim the opposite. */
const PROVIDER_TYPES_BY_NAME: Record<string, { category: string } | undefined> = PROVIDER_TYPES;
interface Provider {
  id: string;
  type: string;
  name: string;
  createdAt: Date;
}

const selectCls =
  "w-full min-h-11 px-3.5 rounded-md bg-surface-secondary border border-separator text-[15px] text-label focus-ring focus:border-accent transition";

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
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string } | "loading">
  >({});

  function testProvider(id: string) {
    setTestResults((r) => ({ ...r, [id]: "loading" }));
    startTransition(async () => {
      const result = await testDataProvider(id);
      setTestResults((r) => ({ ...r, [id]: result }));
    });
  }

  const filteredProviders = providers.filter(
    (p) =>
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.type.includes(search.toLowerCase())
  );

  function startNew() {
    setEditing("new");
    setType("microsoft365");
    setName("");
    setCreds({});
    setVisible({});
  }

  async function startEdit(p: Provider) {
    setLoading(true);
    setEditing(p.id);
    setType(p.type as ProviderType);
    setName(p.name);
    setVisible({});
    const existing = await getProviderCredentials(p.id);
    setCreds(existing);
    setLoading(false);
  }

  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createProvider(type, name, creds);
        else if (editing) await updateProvider(editing, name, creds);
        toast("success", editing === "new" ? t("created") : t("updated"));
        setEditing(null);
      } catch {
        toast("error", t("failedSave"));
      }
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const id = deleting;
    setDeleting(null);
    startTransition(async () => {
      try {
        await deleteProvider(id);
        toast("success", t("deleted"));
      } catch {
        toast("error", t("failedDelete"));
      }
    });
  }

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "opacity-60 pointer-events-none" : ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">
            {t("title")}
          </h1>
          <p className="text-[15px] text-label-secondary mt-1.5">{t("description")}</p>
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
            className="pl-9 pr-9"
            aria-label={t("search")}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label={t("clearSearch")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label focus-ring rounded"
            >
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </div>
        <Button onClick={startNew} leading={<Plus size={16} aria-hidden="true" />}>
          {t("add")}
        </Button>
      </div>

      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden divide-y divide-separator">
        {filteredProviders.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="font-medium text-label truncate">{p.name}</span>
              <StatusPill tone="accent">
                {PROVIDER_TYPES_BY_NAME[p.type]?.category ?? "data"}
              </StatusPill>
              <StatusPill tone="neutral">{p.type}</StatusPill>
            </div>
            <div className="flex gap-2 items-center shrink-0">
              {(() => {
                const r = testResults[p.id];
                if (r === "loading")
                  return (
                    <span className="inline-flex items-center gap-1 text-xs text-label-tertiary">
                      <Loader2
                        size={13}
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                      {t("testing")}
                    </span>
                  );
                if (r?.ok)
                  return (
                    <span className="inline-flex items-center gap-1 text-xs text-green">
                      <Check size={13} aria-hidden="true" />
                      {r.message}
                    </span>
                  );
                if (r && !r.ok)
                  return (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-red max-w-48 truncate"
                      title={r.message}
                    >
                      <X size={13} aria-hidden="true" />
                      {r.message}
                    </span>
                  );
                return null;
              })()}
              <Button size="sm" variant="plain" onClick={() => testProvider(p.id)}>
                {t("test")}
              </Button>
              <Button size="sm" variant="plain" onClick={() => void startEdit(p)}>
                {t("edit")}
              </Button>
              <Button
                size="sm"
                variant="plain"
                className="text-red"
                onClick={() => setDeleting(p.id)}
              >
                {t("delete")}
              </Button>
            </div>
          </div>
        ))}
        {filteredProviders.length === 0 && (
          <EmptyState
            icon={
              providers.length === 0 ? (
                <Plug size={24} aria-hidden="true" />
              ) : (
                <Search size={24} aria-hidden="true" />
              )
            }
            title={providers.length === 0 ? t("noProviders") : t("noMatch")}
            description={providers.length === 0 ? t("noProvidersHint") : undefined}
          />
        )}
      </div>

      {/* Add/edit form + delete confirm */}
      <Modal
        open={!!editing}
        onSubmit={name ? save : undefined}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("addTitle") : t("editTitle")}
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
        {loading && (
          <p className="text-[13px] text-label-tertiary mb-4">{t("loadingCredentials")}</p>
        )}

        {editing === "new" && (
          <>
            <label className="block text-sm font-medium text-label-secondary mb-1">
              {t("type")}
            </label>
            <select
              className={`${selectCls} mb-3`}
              value={type}
              onChange={(e) => {
                setType(e.target.value as ProviderType);
                setCreds({});
              }}
            >
              {Object.entries(PROVIDER_TYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </>
        )}

        <label className="block text-sm font-medium text-label-secondary mb-1">{t("name")}</label>
        <Input
          className="mb-3"
          placeholder={t("namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {PROVIDER_TYPES[type].fields.map((f) => (
          <div key={f.key} className="mb-3">
            <label className="block text-sm font-medium text-label-secondary mb-1">
              {t(f.labelKey)}
              {editing !== "new" && (
                <span className="text-label-tertiary font-normal"> {t("keepCurrent")}</span>
              )}
            </label>
            <div className="relative">
              {f.key === "privateKey" ? (
                <textarea
                  className="w-full px-3.5 py-2.5 rounded-md bg-surface-secondary border border-separator text-[15px] text-label placeholder:text-label-tertiary font-mono h-32 focus-ring focus:border-accent transition"
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                />
              ) : (
                <Input
                  type={f.secret && !visible[f.key] ? "password" : "text"}
                  className="pr-10"
                  value={creds[f.key] ?? ""}
                  onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                />
              )}
              {f.secret && f.key !== "privateKey" && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => ({ ...v, [f.key]: !v[f.key] }))}
                  aria-label={visible[f.key] ? "Hide value" : "Show value"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label focus-ring rounded"
                >
                  {visible[f.key] ? (
                    <EyeOff size={16} aria-hidden="true" />
                  ) : (
                    <Eye size={16} aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          </div>
        ))}

        {type === "ical" && (
          <p className="text-xs text-label-tertiary">
            iCal providers don&apos;t need credentials. The URL is configured per content instance.
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={t("deleteTitle")}
        message={t("deleteMsg")}
        confirmLabel={t("delete")}
        destructive
      />
    </div>
  );
}
