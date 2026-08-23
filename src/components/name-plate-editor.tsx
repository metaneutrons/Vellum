// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

/**
 * Name plate form — a seat list, and nothing to position.
 *
 * The contrast with `door-sign-editor.tsx` is the point: there the operator
 * places boxes on a canvas and then maintains a separate design per display
 * geometry. Here they name the seats and the renderer works out the layout, so
 * this file is a form rather than an editor and has no canvas at all.
 */

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/misc";
import { ResourcePicker } from "@/components/resource-picker";
import {
  MAX_SEATS,
  type NamePlateConfig,
  type Seat,
  type SeatOccupant,
} from "@/lib/content/renderers/name-plate-types";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

interface Provider {
  id: string;
  name: string;
  type: string;
}

interface Props {
  config: Partial<NamePlateConfig>;
  onChange: (config: Partial<NamePlateConfig>) => void;
  providers: Provider[];
}

function emptyStaticSeat(): Seat {
  return { caption: "", occupant: { kind: "static", name: "" } };
}

type CalendarOccupant = Extract<SeatOccupant, { kind: "calendar" }>;

/**
 * Provider and resource for one calendar seat.
 *
 * Its own component so the occupant arrives already narrowed: inside a JSX
 * ternary the union widens again by the time a change handler runs, and spreading
 * it there types the result as "static fields plus a providerId".
 */
function CalendarSeatFields({
  occupant,
  providers,
  onChange,
}: {
  occupant: CalendarOccupant;
  providers: Provider[];
  onChange: (next: CalendarOccupant) => void;
}) {
  const t = useTranslations("content.namePlate");
  const tc = useTranslations("content");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
      <div>
        <label className="block text-[12px] text-label-secondary mb-1">{tc("provider")}</label>
        <select
          className={`${selectCls} w-full`}
          value={occupant.providerId}
          onChange={(e) => onChange({ ...occupant, providerId: e.target.value })}
        >
          <option value="">{tc("selectProvider")}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-[12px] text-label-secondary mb-1">{t("resource")}</label>
        {occupant.providerId ? (
          <ResourcePicker
            providerId={occupant.providerId}
            resourceId={occupant.resourceId}
            resourceName={occupant.resourceName}
            /* The name is stored beside the id on purpose: the renderer falls back
             * to it when the provider is unreachable, so the band still says which
             * place it is instead of showing a bare identifier. */
            onChange={(resourceId, resourceName, _bookingUrl, parentName) =>
              onChange({ ...occupant, resourceId, resourceName, parentName })
            }
          />
        ) : (
          <p className="text-[12px] text-label-tertiary">{tc("selectProvider")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * One seat: where it is, and who is there.
 *
 * Its own component because the row is the whole form: a source switch, a
 * caption, and then either a name or a provider plus resource. Inlined in the
 * `.map()` it ran past what the complexity gate allows, and this is also the
 * place a resource picker will replace the raw id field.
 */
function SeatRow({
  seat,
  providers,
  removable,
  onChange,
  onRemove,
}: {
  seat: Seat;
  providers: Provider[];
  removable: boolean;
  onChange: (seat: Seat) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("content.namePlate");
  return (
    <div className="rounded-md border border-separator p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Segmented
          ariaLabel={t("source")}
          value={seat.occupant.kind}
          /* The calendar option is withheld without a provider: switching to it
           * would produce an empty providerId, which the schema rightly refuses,
           * and the operator would meet that as a failed save rather than as the
           * missing prerequisite it is. */
          options={
            providers.length > 0
              ? [
                  { value: "static" as const, label: t("sourceStatic") },
                  { value: "calendar" as const, label: t("sourceCalendar") },
                ]
              : [{ value: "static" as const, label: t("sourceStatic") }]
          }
          onChange={(kind) =>
            onChange(
              kind === "static"
                ? { caption: seat.caption, occupant: { kind: "static", name: "" } }
                : {
                    caption: seat.caption,
                    occupant: {
                      kind: "calendar",
                      providerId: providers[0]?.id ?? "",
                      resourceId: "",
                    },
                  }
            )
          }
        />
        {removable && (
          <Button variant="plain" onClick={onRemove}>
            {t("removeSeat")}
          </Button>
        )}
      </div>

      <div>
        <label className="block text-[12px] text-label-secondary mb-1">{t("caption")}</label>
        <Input
          placeholder={t("captionPlaceholder")}
          value={seat.caption}
          onChange={(e) => onChange({ ...seat, caption: e.target.value })}
        />
      </div>

      {seat.occupant.kind === "static" ? (
        <div>
          <label className="block text-[12px] text-label-secondary mb-1">{t("staticName")}</label>
          <Input
            placeholder={t("staticNamePlaceholder")}
            value={seat.occupant.name}
            onChange={(e) =>
              onChange({ ...seat, occupant: { kind: "static", name: e.target.value } })
            }
          />
        </div>
      ) : (
        <CalendarSeatFields
          occupant={seat.occupant}
          providers={providers}
          onChange={(occupant) => onChange({ ...seat, occupant })}
        />
      )}
    </div>
  );
}

export function NamePlateEditor({ config, onChange, providers }: Props) {
  const t = useTranslations("content.namePlate");

  /* A plate always has at least one seat, so an unconfigured instance opens with
   * one rather than an empty list the operator has to discover a button for. */
  const seats: Seat[] = config.seats?.length ? config.seats : [emptyStaticSeat()];
  const showStatus = config.showStatus ?? false;

  /* Push that first seat into the config, so what is on screen is what would be
   * saved. Without it a brand-new plate looks configured but sends `{}`, and the
   * server's schema check rejects it for a missing `seats` the operator can see
   * right in front of them. */
  useEffect(() => {
    if (!config.seats?.length) onChange({ ...config, seats });
    /* Once, on mount: re-running on every config change would fight the operator's
     * own edits. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (next: Partial<NamePlateConfig>) => onChange({ ...config, ...next });
  const setSeat = (index: number, seat: Seat) =>
    update({ seats: seats.map((s, i) => (i === index ? seat : s)) });

  /* Any calendar seat makes the status switch meaningful; with none, it would
   * offer to show a state that nothing on the plate has. */
  const anyCalendar = seats.some((s) => s.occupant.kind === "calendar");

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-label-secondary">{t("noEditorHint")}</p>

      <div>
        <label className="block text-sm font-medium text-label-secondary mb-1">
          {t("roomName")}
        </label>
        <Input
          placeholder={t("roomNamePlaceholder")}
          value={config.roomName ?? ""}
          onChange={(e) => update({ roomName: e.target.value })}
        />
        <p className="mt-1 text-[12px] text-label-tertiary">{t("roomNameHint")}</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <label className="block text-sm font-medium text-label-secondary">{t("seats")}</label>
          <span className="text-[12px] text-label-tertiary">{t("maxSeatsHint")}</span>
        </div>

        {seats.map((seat, i) => (
          <SeatRow
            key={i}
            seat={seat}
            providers={providers}
            removable={seats.length > 1}
            onChange={(next) => setSeat(i, next)}
            onRemove={() => update({ seats: seats.filter((_, j) => j !== i) })}
          />
        ))}

        {seats.length < MAX_SEATS && (
          <Button variant="plain" onClick={() => update({ seats: [...seats, emptyStaticSeat()] })}>
            {t("addSeat")}
          </Button>
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 text-[13px] text-label">
          <input
            type="checkbox"
            checked={showStatus}
            disabled={!anyCalendar}
            onChange={(e) => update({ showStatus: e.target.checked })}
          />
          {t("showStatus")}
        </label>
        <p className="mt-1 text-[12px] text-label-tertiary">{t("showStatusHint")}</p>
      </div>
    </div>
  );
}
