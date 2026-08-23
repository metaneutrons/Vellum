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
  READING_DISTANCE_M,
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
  return { caption: "", occupant: { kind: "static", name: "", unit: "", role: "" } };
}

type CalendarOccupant = Extract<SeatOccupant, { kind: "calendar" }>;
type StaticOccupant = Extract<SeatOccupant, { kind: "static" }>;

/**
 * Name, unit and position for a fixed occupant.
 *
 * Its own component for the same reason as `CalendarSeatFields`: inside a JSX
 * ternary the union widens again by the time a change handler runs. Arriving
 * already narrowed lets every handler SPREAD the occupant instead of rebuilding
 * it, and that is what keeps the unit and the position from being discarded on
 * each keystroke in the name field.
 */
function StaticSeatFields({
  occupant,
  onChange,
}: {
  occupant: StaticOccupant;
  onChange: (next: StaticOccupant) => void;
}) {
  const t = useTranslations("content.namePlate");
  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[12px] text-label-secondary mb-1">{t("staticName")}</label>
        <Input
          placeholder={t("staticNamePlaceholder")}
          value={occupant.name}
          onChange={(e) => onChange({ ...occupant, name: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <div>
          <label className="block text-[12px] text-label-secondary mb-1">{t("role")}</label>
          <Input
            placeholder={t("rolePlaceholder")}
            value={occupant.role}
            onChange={(e) => onChange({ ...occupant, role: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] text-label-secondary mb-1">{t("unit")}</label>
          <Input
            placeholder={t("unitPlaceholder")}
            value={occupant.unit}
            onChange={(e) => onChange({ ...occupant, unit: e.target.value })}
          />
        </div>
      </div>
      <p className="text-[12px] text-label-tertiary">{t("affiliationHint")}</p>
    </div>
  );
}

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
            onChange={(resourceId, resourceName, bookingUrl, parentName) =>
              onChange({ ...occupant, resourceId, resourceName, bookingUrl, parentName })
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
 * Where a seat's occupant comes from, plus the remove button.
 *
 * Split off SeatRow to keep both under the complexity gate. The calendar option is
 * withheld without a provider: switching to it would produce an empty providerId,
 * which the schema rightly refuses, and the operator would meet that as a failed
 * save rather than as the missing prerequisite it is.
 */
function SeatSourceSwitch({
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
  const options =
    providers.length > 0
      ? [
          { value: "static" as const, label: t("sourceStatic") },
          { value: "calendar" as const, label: t("sourceCalendar") },
        ]
      : [{ value: "static" as const, label: t("sourceStatic") }];

  return (
    <div className="flex items-center justify-between gap-2">
      <Segmented
        ariaLabel={t("source")}
        value={seat.occupant.kind}
        options={options}
        onChange={(kind) =>
          onChange({
            caption: seat.caption,
            occupant:
              kind === "static"
                ? { kind: "static", name: "", unit: "", role: "" }
                : { kind: "calendar", providerId: providers[0]?.id ?? "", resourceId: "" },
          })
        }
      />
      {removable && (
        <Button variant="plain" onClick={onRemove}>
          {t("removeSeat")}
        </Button>
      )}
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
      <SeatSourceSwitch
        seat={seat}
        providers={providers}
        removable={removable}
        onChange={onChange}
        onRemove={onRemove}
      />

      <div>
        <label className="block text-[12px] text-label-secondary mb-1">{t("caption")}</label>
        <Input
          placeholder={t("captionPlaceholder")}
          value={seat.caption}
          onChange={(e) => onChange({ ...seat, caption: e.target.value })}
        />
      </div>

      {seat.occupant.kind === "static" ? (
        <StaticSeatFields
          occupant={seat.occupant}
          onChange={(occupant) => onChange({ ...seat, occupant })}
        />
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

/**
 * The seat list, with its add button and its reach note.
 *
 * The reach note is the point of splitting this out rather than a nicety: the seat
 * count decides how far the sign can be read, and that was the biggest decision an
 * operator made blind.
 */
function SeatList({
  seats,
  providers,
  onChange,
}: {
  seats: Seat[];
  providers: Provider[];
  onChange: (seats: Seat[]) => void;
}) {
  const t = useTranslations("content.namePlate");
  const metres = (READING_DISTANCE_M[seats.length] ?? 0).toLocaleString("de-DE");
  return (
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
          onChange={(next) => onChange(seats.map((s, j) => (j === i ? next : s)))}
          onRemove={() => onChange(seats.filter((_, j) => j !== i))}
        />
      ))}

      {seats.length < MAX_SEATS && (
        <Button variant="plain" onClick={() => onChange([...seats, emptyStaticSeat()])}>
          {t("addSeat")}
        </Button>
      )}

      <p className="text-[12px] text-label-secondary">
        {t("reach", { metres })}
        {seats.length >= 3 ? ` ${t("reachDense")}` : ""}
      </p>
    </div>
  );
}

/** Whether calendar seats reveal the booking detail as well as the state. */
function StatusToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations("content.namePlate");
  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] text-label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {t("showStatus")}
      </label>
      <p className="mt-1 text-[12px] text-label-tertiary">{t("showStatusHint")}</p>
    </div>
  );
}

/** A select with its label and its explanatory line, since there are two alike. */
function LabeledSelect({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-label-secondary mb-1">{label}</label>
      <select
        className={`${selectCls} w-full`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[12px] text-label-tertiary">{hint}</p>
    </div>
  );
}

/**
 * Whole-plate settings: booking state, header colour, booking code.
 *
 * Each control is withheld rather than offered-and-ignored where it cannot apply.
 * A plate with no calendar seat has no state to show; a QR code needs exactly one
 * seat, because one code cannot say which of four desks it books.
 */
function PlateOptions({
  config,
  seatCount,
  anyCalendar,
  onChange,
}: {
  config: Partial<NamePlateConfig>;
  seatCount: number;
  anyCalendar: boolean;
  onChange: (next: Partial<NamePlateConfig>) => void;
}) {
  const t = useTranslations("content.namePlate");
  return (
    <>
      <StatusToggle
        checked={config.showStatus ?? false}
        disabled={!anyCalendar}
        onChange={(showStatus) => onChange({ showStatus })}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <LabeledSelect
          label={t("accentColor")}
          hint={t("accentColorHint")}
          value={config.accentColor ?? "none"}
          options={(["none", "red", "blue", "green", "yellow"] as const).map((c) => ({
            value: c,
            label: t(`accent.${c}`),
          }))}
          onChange={(v) => onChange({ accentColor: v as NamePlateConfig["accentColor"] })}
        />
        <LabeledSelect
          label={t("bookingQr")}
          hint={t("bookingQrHint")}
          value={config.bookingQr ?? "never"}
          disabled={seatCount !== 1 || !anyCalendar}
          options={(["never", "free", "always"] as const).map((v) => ({
            value: v,
            label: t(`qr.${v}`),
          }))}
          onChange={(v) => onChange({ bookingQr: v as NamePlateConfig["bookingQr"] })}
        />
      </div>
    </>
  );
}

export function NamePlateEditor({ config, onChange, providers }: Props) {
  const t = useTranslations("content.namePlate");

  /* A plate always has at least one seat, so an unconfigured instance opens with
   * one rather than an empty list the operator has to discover a button for. */
  const seats: Seat[] = config.seats?.length ? config.seats : [emptyStaticSeat()];

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

      <SeatList seats={seats} providers={providers} onChange={(next) => update({ seats: next })} />

      <PlateOptions
        config={config}
        seatCount={seats.length}
        anyCalendar={anyCalendar}
        onChange={update}
      />
    </div>
  );
}
