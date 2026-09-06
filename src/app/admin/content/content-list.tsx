// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  createContentInstance,
  updateContentInstance,
  deleteContentInstance,
  testContentInstance,
} from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { LocalePicker } from "@/components/locale-picker";
import { TimezonePicker } from "@/components/timezone-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Plus, Search, FileText, Check, X } from "lucide-react";

interface ContentInstance {
  id: string;
  typeSlug: string;
  name: string;
  config: unknown;
}
interface ContentType {
  slug: string;
  name: string;
  description?: string | null;
}
interface Provider {
  id: string;
  type: string;
  name: string;
}
interface Props {
  instances: ContentInstance[];
  types: ContentType[];
  providers: Provider[];
  initialEditId?: string | null;
}

import { ResourcePicker } from "@/components/resource-picker";
import { NamePlateEditor } from "@/components/name-plate-editor";
import { ROOM_POLICIES } from "@/lib/content/renderers/room-booking-types";
import { recordNumber, recordString } from "@/lib/record-value";

/**
 * What each date format looks like, shown in the CONTENT's language.
 *
 * These four options used to be hardcoded German samples, so an operator setting
 * up an English sign picked between "Sonntag, 3. Mai 2026" and "03.05.26" and had
 * to imagine the rest. The sample is now formatted in the language the sign will
 * actually use.
 *
 * `dateStyle` rather than date-fns: the two are documented as corresponding
 * (P short, PP medium, PPP long, PPPP full), the renderer's own patterns stay the
 * stored value, and Intl costs the client bundle nothing.
 */
const DATE_SAMPLE = new Date(Date.UTC(2026, 4, 3, 12));
const DATE_FORMAT_SAMPLES: Array<[string, "full" | "long" | "medium" | "short"]> = [
  ["PPPP", "full"],
  ["PPP", "long"],
  ["PP", "medium"],
  ["P", "short"],
];

const selectCls =
  "w-full min-h-9 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

/* The `door-sign` and `door-sign-multi` editors lived here until 2026-08-25.
 * Both types are unregistered and their editors are parked under
 * `components/retired/`; see docs/door-sign-retirement.md for why they are kept
 * rather than deleted. Nothing can create an instance of either, so nothing can
 * reach an editor for one. */

function RoomBookingEditor({
  config,
  onChange,
  providers,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  providers: Provider[];
}) {
  const t = useTranslations("content");
  const tCommon = useTranslations("common");
  const roomConfig = (config.roomConfig ?? {}) as Record<string, string>;
  const bookingQr = (config.bookingQr ?? { visibility: "never", source: "provider" }) as {
    visibility?: "never" | "always" | "free";
    source?: "provider" | "custom";
    customUrl?: string;
  };
  const provider = providers.find((p) => p.id === config.providerId);

  const isAnny = provider?.type === "anny";
  const fieldConfig =
    provider?.type === "google"
      ? {
          label: t("fieldCalendarId"),
          placeholder: "calendar-id@group.calendar.google.com",
          key: "calendarId",
        }
      : provider?.type === "anny"
        ? { label: t("fieldResource"), placeholder: "", key: "resourceId" }
        : provider?.type === "ical"
          ? null /* iCal URL is in provider credentials, not room config */
          : { label: t("fieldRoomEmail"), placeholder: "room@company.com", key: "roomEmail" };

  return (
    <>
      <label className="block text-sm font-medium text-label-secondary mb-1">{t("provider")}</label>
      <select
        className={`${selectCls} mb-3`}
        value={recordString(config, "providerId")}
        onChange={(e) => onChange({ ...config, providerId: e.target.value })}
      >
        <option value="">{tCommon("select")}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.type})
          </option>
        ))}
      </select>

      <label className="block text-sm font-medium text-label-secondary mb-1">{t("roomName")}</label>
      <Input
        className="mb-3"
        placeholder={t("roomNamePlaceholder")}
        value={recordString(config, "roomName")}
        onChange={(e) => onChange({ ...config, roomName: e.target.value })}
      />

      <label className="block text-sm font-medium text-label-secondary mb-1">
        {fieldConfig?.label ?? ""}
      </label>
      {isAnny && config.providerId ? (
        <div className="mb-3">
          <ResourcePicker
            providerId={config.providerId as string}
            resourceId={roomConfig.resourceId ?? ""}
            resourceName={roomConfig.resourceName}
            onChange={(resId, resName, bookingUrl) =>
              onChange({
                ...config,
                roomConfig: {
                  resourceId: resId,
                  resourceName: resName,
                  ...(bookingUrl ? { bookingUrl } : {}),
                },
                roomName: (config.roomName as string) || resName,
              })
            }
          />
        </div>
      ) : fieldConfig ? (
        <Input
          className="mb-3"
          placeholder={fieldConfig.placeholder}
          value={roomConfig[fieldConfig.key] ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              roomConfig: { ...roomConfig, [fieldConfig.key]: e.target.value },
            })
          }
        />
      ) : (
        <div className="mb-3" />
      )}

      <TimezonePicker
        label={t("timezone")}
        className="mb-3"
        value={recordString(config, "timezone", "Europe/Berlin")}
        onChange={(v) => onChange({ ...config, timezone: v })}
      />

      <LocalePicker
        label={t("locale")}
        className="mb-3"
        value={recordString(config, "locale", "en")}
        onChange={(v) => onChange({ ...config, locale: v })}
      />

      <label className="block text-sm font-medium text-label-secondary mb-1">
        {t("dateFormat")}
      </label>
      <select
        className={`${selectCls} mb-3`}
        value={recordString(config, "dateFormat", "PPPP")}
        onChange={(e) => onChange({ ...config, dateFormat: e.target.value })}
      >
        {DATE_FORMAT_SAMPLES.map(([pattern, style]) => (
          <option key={pattern} value={pattern}>
            {new Intl.DateTimeFormat(recordString(config, "locale", "en"), {
              dateStyle: style,
            }).format(DATE_SAMPLE)}
          </option>
        ))}
      </select>

      <label className="block text-sm font-medium text-label-secondary mb-1">{t("layout")}</label>
      <select
        className={`${selectCls} mb-3`}
        value={recordString(config, "layout", "timeline")}
        onChange={(e) => onChange({ ...config, layout: e.target.value })}
      >
        <option value="timeline">{t("timeline")}</option>
        <option value="stacked">{t("stacked")}</option>
      </select>

      <label className="block text-sm font-medium text-label-secondary mb-1">{t("policy")}</label>
      <select
        className={`${selectCls} mb-3`}
        value={recordString(config, "policy", "Show All")}
        onChange={(e) => onChange({ ...config, policy: e.target.value })}
      >
        {ROOM_POLICIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <div className="border-t border-separator pt-3 mt-1 mb-3">
        <label className="block text-sm font-semibold text-label mb-1">{t("bookingQr")}</label>
        <p className="text-xs text-label-tertiary mb-2">{t("bookingQrHint")}</p>
        <label className="block text-sm font-medium text-label-secondary mb-1">
          {t("bookingQrVisibility")}
        </label>
        <select
          className={`${selectCls} mb-2`}
          value={bookingQr.visibility ?? "never"}
          onChange={(e) =>
            onChange({ ...config, bookingQr: { ...bookingQr, visibility: e.target.value } })
          }
        >
          <option value="never">{t("bookingQrNever")}</option>
          <option value="always">{t("bookingQrAlways")}</option>
          <option value="free">{t("bookingQrWhenFree")}</option>
        </select>

        <label className="block text-sm font-medium text-label-secondary mb-1">
          {t("bookingQrLink")}
        </label>
        <select
          className={`${selectCls} mb-2`}
          value={bookingQr.source ?? "provider"}
          onChange={(e) =>
            onChange({ ...config, bookingQr: { ...bookingQr, source: e.target.value } })
          }
        >
          <option value="provider">
            {isAnny && roomConfig.bookingUrl
              ? t("bookingQrProviderAvailable")
              : t("bookingQrProvider")}
          </option>
          <option value="custom">{t("bookingQrCustom")}</option>
        </select>
        {bookingQr.source === "custom" && (
          <Input
            type="url"
            placeholder={t("bookingQrCustomPlaceholder")}
            value={bookingQr.customUrl ?? ""}
            onChange={(e) =>
              onChange({ ...config, bookingQr: { ...bookingQr, customUrl: e.target.value } })
            }
          />
        )}
        {bookingQr.source !== "custom" && !roomConfig.bookingUrl && (
          <p className="text-xs text-label-tertiary">{t("bookingQrUnavailable")}</p>
        )}
      </div>

      <label className="block text-sm font-medium text-label-secondary mb-1">{t("cacheTtl")}</label>
      <Input
        type="number"
        className="mb-3"
        min={0}
        step={30}
        placeholder="120"
        value={recordNumber(config, "cacheTtlS", 120)}
        onChange={(e) => onChange({ ...config, cacheTtlS: parseInt(e.target.value) || 120 })}
      />
    </>
  );
}

export function ContentList({ instances, types, providers, initialEditId }: Props) {
  const { toast } = useToast();
  const tc = useTranslations("contentTypes");
  const t = useTranslations("content");
  const uiLocale = useLocale();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(initialEditId ?? null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [typeSlug, setTypeSlug] = useState("room-booking");
  const [search, setSearch] = useState("");
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string } | "loading">
  >({});
  const filteredInstances = instances.filter(
    (inst) =>
      !search ||
      inst.name.toLowerCase().includes(search.toLowerCase()) ||
      inst.typeSlug.includes(search.toLowerCase())
  );
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, unknown>>({});

  function startNew() {
    setEditing("new");
    setTypeSlug("room-booking");
    setName("");
    setConfig({ timezone: "Europe/Berlin", policy: "Show All", locale: uiLocale });
  }

  function startEdit(inst: ContentInstance) {
    setEditing(inst.id);
    setTypeSlug(inst.typeSlug);
    setName(inst.name);
    setConfig(inst.config as Record<string, unknown>);
  }

  // Auto-open editor when navigated from device table
  useEffect(() => {
    if (initialEditId) {
      const inst = instances.find((i) => i.id === initialEditId);
      if (inst) startEdit(inst);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function save() {
    startTransition(async () => {
      try {
        if (editing === "new") await createContentInstance(typeSlug, name, config);
        else if (editing) await updateContentInstance(editing, name, config);
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
        await deleteContentInstance(id);
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
            className="pl-9"
            aria-label={t("search")}
          />
        </div>
        <Button onClick={startNew} leading={<Plus size={16} aria-hidden="true" />}>
          {t("add")}
        </Button>
      </div>

      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden divide-y divide-separator">
        {filteredInstances.map((inst) => (
          <div key={inst.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-medium text-label truncate">{inst.name}</span>
              <StatusPill tone="neutral">{tc(inst.typeSlug as string)}</StatusPill>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {(() => {
                const r = testResults[inst.id];
                if (r === "loading")
                  return (
                    <span className="text-xs text-label-tertiary animate-pulse">{t("test")}…</span>
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
                      <X size={13} aria-hidden="true" className="shrink-0" />
                      {r.message}
                    </span>
                  );
                return null;
              })()}
              <Button
                size="sm"
                variant="plain"
                onClick={() => {
                  setTestResults((s) => ({ ...s, [inst.id]: "loading" }));
                  startTransition(async () => {
                    const res = await testContentInstance(inst.id);
                    setTestResults((s) => ({ ...s, [inst.id]: res }));
                  });
                }}
              >
                {t("test")}
              </Button>
              <Button size="sm" variant="plain" onClick={() => setPreviewing(inst.id)}>
                {t("preview")}
              </Button>
              <Button size="sm" variant="gray" onClick={() => startEdit(inst)}>
                {t("edit")}
              </Button>
              <Button
                size="sm"
                variant="plain"
                className="text-red"
                onClick={() => setDeleting(inst.id)}
              >
                {t("delete")}
              </Button>
            </div>
          </div>
        ))}
        {filteredInstances.length === 0 && (
          <EmptyState
            icon={
              instances.length === 0 ? (
                <FileText size={24} aria-hidden="true" />
              ) : (
                <Search size={24} aria-hidden="true" />
              )
            }
            title={instances.length === 0 ? t("noContent") : t("noMatch")}
            description={instances.length === 0 ? t("noContentHint") : undefined}
          />
        )}
      </div>

      <Modal
        open={!!editing}
        onSubmit={name ? save : undefined}
        onClose={() => setEditing(null)}
        title={editing === "new" ? t("newTitle") : t("editTitle")}
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
        {editing === "new" && (
          <>
            <label className="block text-sm font-medium text-label-secondary mb-1">
              {t("contentType")}
            </label>
            <select
              className={`${selectCls} mb-3`}
              value={typeSlug}
              onChange={(e) => setTypeSlug(e.target.value)}
            >
              {types.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {tc(t.slug as string)}
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

        {typeSlug === "room-booking" && (
          <RoomBookingEditor config={config} onChange={setConfig} providers={providers} />
        )}
        {typeSlug === "name-plate" && (
          <NamePlateEditor config={config} onChange={setConfig} providers={providers} />
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

      <Modal open={!!previewing} onClose={() => setPreviewing(null)} title={t("previewTitle")}>
        {previewing && (
          <img
            src={`/api/v1/admin/preview?instanceId=${previewing}&t=${Date.now()}`}
            alt={t("preview")}
            className="w-full rounded-md border border-separator"
          />
        )}
      </Modal>
    </div>
  );
}
