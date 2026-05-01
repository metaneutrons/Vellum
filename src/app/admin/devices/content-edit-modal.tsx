// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { updateContentInstance } from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { Button } from "@/components/button";
import { DoorSignEditor } from "@/components/door-sign-editor";
import { AnnyResourcePicker } from "@/components/anny-resource-picker";
import { ROOM_POLICIES } from "@/lib/content/renderers/room-booking-types";
import type { Design, DisplaySize } from "@/lib/content/renderers/door-sign-types";

interface ContentInstance { id: string; name: string; typeSlug: string; config: unknown; }
interface Provider { id: string; type: string; name: string; }

interface Props {
  instanceId: string;
  contentInstances: ContentInstance[];
  providers: Provider[];
  knownDisplays: DisplaySize[];
  onClose: () => void;
}

export function ContentEditModal({ instanceId, contentInstances, providers, knownDisplays, onClose }: Props) {
  const instance = contentInstances.find(i => i.id === instanceId);
  const { toast } = useToast();
  const t = useTranslations("content");
  const td = useTranslations("content.doorSign");
  const tc = useTranslations("contentTypes");
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(instance?.name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>((instance?.config as Record<string, unknown>) ?? {});

  if (!instance) return null;

  function save() {
    startTransition(async () => {
      try {
        await updateContentInstance(instanceId, name, config);
        toast("success", t("save"));
        onClose();
      } catch { toast("error", "Failed"); }
    });
  }

  return (
    <Modal
      open
      wide={instance.typeSlug === "door-sign"}
      onClose={onClose}
      title={`${tc(instance.typeSlug as "room-booking" | "door-sign")}: ${name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={save} disabled={!name} pending={pending}>{t("save")}</Button>
        </>
      }
    >
      <label className="block text-sm font-medium mb-1">{t("name")}</label>
      <input className="w-full border rounded px-3 py-2 mb-3 text-sm" value={name} onChange={e => setName(e.target.value)} />

      {instance.typeSlug === "door-sign" && (
        <>
          <label className="block text-sm font-medium mb-1">{t("provider")}</label>
          <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.providerId as string) ?? ""}
            onChange={e => setConfig({ ...config, providerId: e.target.value })}>
            <option value="">{t("selectProvider")}</option>
            {providers.filter(p => p.type === "anny").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          {config.providerId && (
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">{td("resource")}</label>
              <AnnyResourcePicker
                providerId={config.providerId as string}
                resourceId={(config.resourceId as string) ?? ""}
                resourceName={config.resourceName as string | undefined}
                onChange={(resId, resName) => setConfig({ ...config, resourceId: resId, resourceName: resName })}
              />
            </div>
          )}

          <div className="border-t pt-3 mt-3">
            <label className="block text-sm font-semibold mb-2">{td("visualLayout")}</label>
            <DoorSignEditor
              design={(config.design ?? { backgroundAssetId: null, textBoxes: [], freeTextBoxes: [], backgroundColor: "#FFFFFF" }) as Design}
              designOverrides={(config.designOverrides ?? {}) as Record<string, Design>}
              onChange={(d, o) => setConfig({ ...config, design: d, designOverrides: o })}
              knownDisplays={knownDisplays}
              providerId={config.providerId as string}
              resourceId={config.resourceId as string}
              onPropertiesResolved={props => setConfig({ ...config, cachedProperties: props })}
            />
          </div>
        </>
      )}

      {instance.typeSlug === "room-booking" && (
        <>
          <label className="block text-sm font-medium mb-1">{t("provider")}</label>
          <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.providerId as string) ?? ""}
            onChange={e => setConfig({ ...config, providerId: e.target.value })}>
            <option value="">{t("selectProvider")}</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
          </select>

          <label className="block text-sm font-medium mb-1">{t("roomName")}</label>
          <input className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.roomName as string) ?? ""}
            onChange={e => setConfig({ ...config, roomName: e.target.value })} />

          <label className="block text-sm font-medium mb-1">{t("timezone")}</label>
          <input className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.timezone as string) ?? "Europe/Berlin"}
            onChange={e => setConfig({ ...config, timezone: e.target.value })} />

          <label className="block text-sm font-medium mb-1">{t("policy")}</label>
          <select className="w-full border rounded px-3 py-2 mb-3 text-sm" value={(config.policy as string) ?? "Show All"}
            onChange={e => setConfig({ ...config, policy: e.target.value })}>
            {ROOM_POLICIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </>
      )}
    </Modal>
  );
}
