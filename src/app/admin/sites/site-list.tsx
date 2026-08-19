// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createSite, updateSite, deleteSite } from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/misc";
import { MapPin, Plus, Pencil, Trash2 } from "lucide-react";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

interface Site {
  id: string;
  name: string;
  timezone: string;
  refreshProfileId: string | null;
  themeId: string | null;
  contentInstanceId: string | null;
}

interface Named {
  id: string;
  name: string;
}

interface Props {
  sites: Site[];
  themes: Named[];
  profiles: Named[];
  contentInstances: Named[];
}

/* A short list of zones covering the fleet, with free text for everything else.
 * A full IANA list is 400-plus entries and unusable in a select; the server
 * validates whatever arrives against Intl either way, so a typo is refused at the
 * action rather than accepted and discovered on a display months later. */
const COMMON_ZONES = [
  "Europe/Berlin",
  "Europe/London",
  "Europe/Zurich",
  "Europe/Vienna",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Singapore",
  "UTC",
];

const empty = {
  name: "",
  timezone: "Europe/Berlin",
  refreshProfileId: "",
  themeId: "",
  contentInstanceId: "",
};

export function SiteList({ sites, themes, profiles, contentInstances }: Props) {
  const t = useTranslations("sites");
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [deleting, setDeleting] = useState<Site | null>(null);

  function open(site?: Site) {
    if (site) {
      setEditing(site.id);
      setForm({
        name: site.name,
        timezone: site.timezone,
        refreshProfileId: site.refreshProfileId ?? "",
        themeId: site.themeId ?? "",
        contentInstanceId: site.contentInstanceId ?? "",
      });
    } else {
      setEditing("new");
      setForm(empty);
    }
  }

  function save() {
    const payload = {
      name: form.name.trim(),
      timezone: form.timezone.trim(),
      refreshProfileId: form.refreshProfileId || null,
      themeId: form.themeId || null,
      contentInstanceId: form.contentInstanceId || null,
    };
    if (!payload.name || !payload.timezone) return;
    startTransition(async () => {
      try {
        if (editing === "new") await createSite(payload);
        else if (editing) await updateSite(editing, payload);
        setEditing(null);
        toast("success", t("saved"));
        router.refresh();
      } catch {
        toast("error", t("saveFailed"));
      }
    });
  }

  function remove(site: Site) {
    startTransition(async () => {
      try {
        await deleteSite(site.id);
        setDeleting(null);
        toast("success", t("deleted"));
        router.refresh();
      } catch {
        toast("error", t("deleteFailed"));
      }
    });
  }

  const nameOf = (list: Named[], id: string | null) =>
    id ? (list.find((x) => x.id === id)?.name ?? "—") : t("notSet");

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "pointer-events-none opacity-60" : ""}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-label">{t("title")}</h2>
          <p className="mt-1 text-xs text-gray-500">{t("hint")}</p>
        </div>
        <Button onClick={() => open()}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t("add")}
        </Button>
      </div>

      {sites.length === 0 ? (
        <EmptyState icon={<MapPin className="h-6 w-6" />} title={t("empty")} />
      ) : (
        <div className="space-y-2">
          {sites.map((site) => (
            <div
              key={site.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-separator bg-surface p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-label">{site.name}</div>
                <div className="mt-0.5 font-mono text-xs text-gray-500">{site.timezone}</div>
              </div>
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                <div>
                  <dt className="inline">{t("profile")}: </dt>
                  <dd className="inline text-label">{nameOf(profiles, site.refreshProfileId)}</dd>
                </div>
                <div>
                  <dt className="inline">{t("theme")}: </dt>
                  <dd className="inline text-label">{nameOf(themes, site.themeId)}</dd>
                </div>
                <div>
                  <dt className="inline">{t("content")}: </dt>
                  <dd className="inline text-label">
                    {nameOf(contentInstances, site.contentInstanceId)}
                  </dd>
                </div>
              </dl>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label={t("edit")}
                  onClick={() => open(site)}
                  className="focus-ring rounded p-2 text-gray-500 hover:text-label"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label={t("delete")}
                  onClick={() => setDeleting(site)}
                  className="focus-ring rounded p-2 text-gray-500 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={editing === "new" ? t("add") : t("edit")}
        >
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">{t("name")}</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("namePlaceholder")}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">{t("timezone")}</span>
              <Input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                list="vellum-site-zones"
                placeholder="Europe/Berlin"
              />
              <datalist id="vellum-site-zones">
                {COMMON_ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              <span className="mt-1 block text-xs text-gray-500">{t("timezoneHint")}</span>
            </label>

            <p className="text-xs text-gray-500">{t("defaultsHint")}</p>

            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">{t("profile")}</span>
              <select
                className={`${selectCls} w-full`}
                value={form.refreshProfileId}
                onChange={(e) => setForm({ ...form, refreshProfileId: e.target.value })}
              >
                <option value="">{t("notSet")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">{t("theme")}</span>
              <select
                className={`${selectCls} w-full`}
                value={form.themeId}
                onChange={(e) => setForm({ ...form, themeId: e.target.value })}
              >
                <option value="">{t("notSet")}</option>
                {themes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">{t("content")}</span>
              <select
                className={`${selectCls} w-full`}
                value={form.contentInstanceId}
                onChange={(e) => setForm({ ...form, contentInstanceId: e.target.value })}
              >
                <option value="">{t("notSet")}</option>
                {contentInstances.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="plain" onClick={() => setEditing(null)}>
                {t("cancel")}
              </Button>
              <Button onClick={save} disabled={pending}>
                {t("save")}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          open
          title={t("deleteTitle")}
          /* Named explicitly because the consequence is invisible otherwise: the
             displays stay, lose their site, and fall back to the workspace
             defaults and the server clock. */
          message={t("deleteMessage", { name: deleting.name })}
          confirmLabel={t("delete")}
          destructive
          pending={pending}
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
