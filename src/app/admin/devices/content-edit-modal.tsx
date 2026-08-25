// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { updateContentInstance } from "../actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { ROOM_POLICIES } from "@/lib/content/renderers/room-booking-types";

interface ContentInstance {
  id: string;
  name: string;
  typeSlug: string;
  config: unknown;
}
interface Provider {
  id: string;
  type: string;
  name: string;
}

interface Props {
  instanceId: string;
  contentInstances: ContentInstance[];
  providers: Provider[];
  onClose: () => void;
}

const selectCls =
  "w-full min-h-11 px-3.5 rounded-md bg-surface-secondary border border-separator text-[15px] text-label focus-ring focus:border-accent transition";

export function ContentEditModal({ instanceId, contentInstances, providers, onClose }: Props) {
  const instance = contentInstances.find((i) => i.id === instanceId);
  const { toast } = useToast();
  const t = useTranslations("content");
  const tCommon = useTranslations("common");
  const tc = useTranslations("contentTypes");
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(instance?.name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(
    (instance?.config as Record<string, unknown>) ?? {}
  );

  if (!instance) return null;

  function save() {
    startTransition(async () => {
      try {
        await updateContentInstance(instanceId, name, config);
        toast("success", t("save"));
        onClose();
      } catch {
        toast("error", tCommon("failed"));
      }
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${tc(instance.typeSlug as "room-booking" | "name-plate")}: ${name}`}
      footer={
        <>
          <Button variant="gray" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={save} disabled={!name} loading={pending}>
            {t("save")}
          </Button>
        </>
      }
    >
      <label className="block text-sm font-medium text-label-secondary mb-1">{t("name")}</label>
      <Input className="mb-3" value={name} onChange={(e) => setName(e.target.value)} />

      {/* The `door-sign` branch stood here until 2026-08-25. The type is
          unregistered and its editor is parked under `components/retired/`, so no
          instance of it can exist to be edited. */}

      {instance.typeSlug === "room-booking" && (
        <>
          <label className="block text-sm font-medium text-label-secondary mb-1">
            {t("provider")}
          </label>
          <select
            className={`${selectCls} mb-3`}
            value={(config.providerId as string) ?? ""}
            onChange={(e) => setConfig({ ...config, providerId: e.target.value })}
          >
            <option value="">{t("selectProvider")}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.type})
              </option>
            ))}
          </select>

          <label className="block text-sm font-medium text-label-secondary mb-1">
            {t("roomName")}
          </label>
          <Input
            className="mb-3"
            value={(config.roomName as string) ?? ""}
            onChange={(e) => setConfig({ ...config, roomName: e.target.value })}
          />

          <label className="block text-sm font-medium text-label-secondary mb-1">
            {t("timezone")}
          </label>
          <Input
            className="mb-3"
            value={(config.timezone as string) ?? "Europe/Berlin"}
            onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
          />

          <label className="block text-sm font-medium text-label-secondary mb-1">
            {t("policy")}
          </label>
          <select
            className={`${selectCls} mb-3`}
            value={(config.policy as string) ?? "Show All"}
            onChange={(e) => setConfig({ ...config, policy: e.target.value })}
          >
            {ROOM_POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </>
      )}
    </Modal>
  );
}
