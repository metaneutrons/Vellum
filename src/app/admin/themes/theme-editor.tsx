// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { createTheme, updateTheme, deleteTheme, setDefaultTheme } from "../actions";
import { useToast } from "@/components/toast";
import { ThemePreview } from "@/components/theme-preview";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Plus, Pencil, Trash2, Search, Palette } from "lucide-react";
import type { Theme } from "@/lib/theme";
import { useTranslations } from "next-intl";

const THEME_FIELDS: { key: keyof Theme; labelKey: string }[] = [
  { key: "headerBg", labelKey: "colorHeaderBg" },
  { key: "headerText", labelKey: "colorHeaderText" },
  { key: "freeBadge", labelKey: "colorFreeBadge" },
  { key: "busyBadge", labelKey: "colorBusyBadge" },
  { key: "badgeText", labelKey: "colorBadgeText" },
  { key: "background", labelKey: "colorBackground" },
  { key: "eventBg", labelKey: "colorEventBg" },
  { key: "slotText", labelKey: "colorSlotText" },
  { key: "slotSecondary", labelKey: "colorSlotSecondary" },
  { key: "footerText", labelKey: "colorFooterText" },
];

const DEFAULT_CONFIG: Theme = {
  name: "",
  headerBg: "#000000",
  headerText: "#FFFFFF",
  freeBadge: "#008000",
  busyBadge: "#FF0000",
  badgeText: "#FFFFFF",
  background: "#FFFFFF",
  eventBg: "#000000",
  slotText: "#FFFFFF",
  slotSecondary: "#000000",
  footerText: "#000000",
};

interface DbTheme {
  id: string;
  name: string;
  config: unknown;
  isDefault: boolean;
}

export function ThemeEditor({ themes }: { themes: DbTheme[] }) {
  const tt = useTranslations("themes");
  // The "Set as default" label lives under profiles; both objects share it.
  const tp = useTranslations("profiles");
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const filteredThemes = themes.filter(
    (t) => !search || t.name.toLowerCase().includes(search.toLowerCase())
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Theme>(DEFAULT_CONFIG);

  function startEdit(t: DbTheme) {
    setEditing(t.id);
    setName(t.name);
    setConfig(t.config as Theme);
  }
  function startNew() {
    setEditing("new");
    setName("");
    setConfig(DEFAULT_CONFIG);
  }

  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createTheme(name, config as unknown as Record<string, string>);
        else if (editing)
          await updateTheme(editing, name, config as unknown as Record<string, string>);
        toast("success", editing === "new" ? tt("created") : tt("updated"));
        setEditing(null);
      } catch {
        toast("error", tt("saveFailed"));
      }
    });
  }

  function makeDefault(id: string) {
    startTransition(async () => {
      try {
        await setDefaultTheme(id);
        toast("success", tp("defaultSet"));
      } catch {
        toast("error", "Failed to set default");
      }
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const id = deleting;
    setDeleting(null);
    startTransition(async () => {
      try {
        await deleteTheme(id);
        toast("success", tt("deleted"));
      } catch {
        toast("error", tt("deleteFailed"));
      }
    });
  }

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "opacity-60 pointer-events-none" : ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">
            {tt("title")}
          </h1>
          <p className="text-[15px] text-label-secondary mt-1.5">{tt("description")}</p>
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
            placeholder={tt("search")}
            className="pl-9"
            aria-label={tt("search")}
          />
        </div>
        <Button onClick={startNew} leading={<Plus size={16} aria-hidden="true" />}>
          {tt("add")}
        </Button>
      </div>

      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 divide-y divide-separator overflow-hidden">
        {filteredThemes.map((t) => (
          <div key={t.id} className="flex items-center justify-between px-4 py-3 gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-medium text-label truncate">{t.name}</span>
              {t.isDefault && <StatusPill tone="accent">{tt("default")}</StatusPill>}
              <div className="flex gap-1">
                {Object.values(t.config as Record<string, string>)
                  .filter((v) => typeof v === "string" && v.startsWith("#"))
                  .slice(0, 6)
                  .map((color, i) => (
                    <div
                      key={i}
                      className="size-4 rounded border border-separator"
                      style={{ backgroundColor: color }}
                    />
                  ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!t.isDefault && (
                <Button size="sm" variant="plain" onClick={() => makeDefault(t.id)}>
                  {tp("setAsDefault")}
                </Button>
              )}
              <Button
                size="sm"
                variant="plain"
                onClick={() => startEdit(t)}
                leading={<Pencil size={16} aria-hidden="true" />}
              >
                {tt("edit")}
              </Button>
              <Button
                size="sm"
                variant="plain"
                aria-label={tt("delete")}
                onClick={() => setDeleting(t.id)}
                className="text-red px-2"
              >
                <Trash2 size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        {filteredThemes.length === 0 && (
          <EmptyState
            icon={<Palette size={24} aria-hidden="true" />}
            title={themes.length === 0 ? "No themes yet" : "No themes match your search"}
            description={
              themes.length === 0
                ? "Create a theme to customize the display appearance."
                : undefined
            }
          />
        )}
      </div>

      {/* Theme editor + delete confirm */}
      <Modal
        open={!!editing}
        onSubmit={name ? save : undefined}
        onClose={() => setEditing(null)}
        title={editing === "new" ? tt("newTheme") : tt("editTheme")}
        footer={
          <>
            <Button variant="gray" onClick={() => setEditing(null)}>
              {tt("cancel")}
            </Button>
            <Button onClick={save} disabled={!name} loading={pending}>
              {tt("save")}
            </Button>
          </>
        }
      >
        <div className="mb-4">
          <Field label={tt("name")} htmlFor="theme-name">
            <Input id="theme-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {THEME_FIELDS.map((f) => (
            <label
              key={f.key}
              className="flex items-center gap-2.5 rounded-md bg-surface-secondary border border-separator px-3 py-2 text-[13px] text-label"
            >
              <input
                type="color"
                value={(config as unknown as Record<string, string>)[f.key] ?? "#000000"}
                onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                className="size-8 shrink-0 rounded-md border border-separator bg-surface-secondary cursor-pointer focus-ring"
              />
              {tt(f.labelKey)}
            </label>
          ))}
        </div>
        <div className="mt-4">
          <span className="block text-sm font-medium text-label mb-2">{tt("preview")}</span>
          <ThemePreview theme={config} />
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title={tt("deleteThemeTitle")}
        message={tt("deleteThemeMessage")}
        confirmLabel={tt("delete")}
        destructive
      />
    </div>
  );
}
