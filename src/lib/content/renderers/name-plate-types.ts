// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Name plate — the door sign WITHOUT an editor.
 *
 * The operator names the seats and nothing else; the renderer decides the
 * layout from the seat count and the panel it is drawing on. That is the whole
 * difference from `door-sign`, which hands absolute box positions to the
 * operator and then needs a separate hand-made design per display geometry to
 * survive a change of aspect ratio.
 *
 * A seat carries two DIFFERENT pieces of text, and keeping them apart is the
 * point of this shape:
 *
 *   caption  — the place. "Schreibtisch 1", "Platz A". Omitted on a single
 *              office door, where the sign is only about the person.
 *   occupant — who is there. Either a fixed name, which needs no calendar at
 *              all, or a calendar resource whose current booking supplies it.
 *
 * An earlier draft had one `label` field serving both roles, which made the
 * question "does the static name or the calendar name win?" look meaningful. It
 * is not: they are different data, and a static seat has no calendar to lose to.
 *
 * A fixed occupant can also name a unit and a position. Those live on the STATIC
 * variant only, and that asymmetry is a finding rather than an oversight: both
 * configured providers were queried and neither carries the data. See the comment
 * on `unit`.
 */

import { z } from "zod";
import { BOOKING_QR_VISIBILITIES } from "./booking-qr";

/**
 * Four, deliberately.
 *
 * Beyond that a plate stops being readable from across a room: the name is the
 * payload, and five bands on a 7.5" panel leave each one shorter than the type
 * it needs. It also keeps the layout to a handful of cases that can be judged by
 * eye rather than a formula that is mediocre at every count.
 */
export const MAX_SEATS = 4;

export const seatOccupantSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("static"),
    /** Shown verbatim. No provider, no lookup, no booking state. */
    name: z.string().min(1),
    /**
     * Organisational unit, such as "Präsidium".
     *
     * The unit, deliberately, and not the employer. Both providers configured
     * against this instance were queried before these fields were added and
     * neither can supply them. anny's customer carries a single free-text
     * `company` that reads "Hochschule Hannover" on 130 of 168 records, which
     * says nothing on an internal door; its custom-field mechanism exists but has
     * no definitions, and it models no teams, groups or departments at all. The
     * Microsoft 365 tenant leaves `department` unset on every human and fills
     * `jobTitle` for 7 of 39 members, and a guest object carries none of its home
     * tenant's attributes in any case. A field the operator fills once beats a
     * lookup that comes back blank.
     */
    unit: z.string().default(""),
    /** Position within that unit, such as "Vizepräsident". */
    role: z.string().default(""),
  }),
  z.object({
    kind: z.literal("calendar"),
    providerId: z.string().uuid(),
    resourceId: z.string().min(1),
    /** Passed to the provider; some need it to resolve the resource. */
    resourceName: z.string().optional(),
    /**
     * The room this seat sits in, as the provider named it.
     *
     * Stored so the header can fall back to it: anny's seats are children of a
     * room ("Föhr 1" inside "S1 2er Flexbüro Föhr"), and an operator who picked
     * the seats has already said which room this is.
     */
    parentName: z.string().optional(),
    /**
     * Public booking link for this resource, as the provider gave it.
     *
     * Stored so a plate can offer a QR code. Never derived from a name or an id:
     * anny's resource id and its public slug are unrelated, so a guessed link
     * leads somewhere wrong or nowhere.
     */
    bookingUrl: z.string().url().max(256).optional(),
  }),
]);

export type SeatOccupant = z.infer<typeof seatOccupantSchema>;

export const seatSchema = z.object({
  /** The place. Empty string means "no caption", not "caption is blank". */
  caption: z.string().default(""),
  occupant: seatOccupantSchema,
});

export type Seat = z.infer<typeof seatSchema>;

export const namePlateConfigSchema = z.object({
  /**
   * The room, shown in the header.
   *
   * A door sign says WHERE it is before it says who is inside, the same way the
   * room-booking display does. Empty falls back to the room the seats came from,
   * and with neither there is simply no header.
   */
  roomName: z.string().default(""),
  seats: z.array(seatSchema).min(1).max(MAX_SEATS),
  /**
   * Whether calendar seats show free/occupied.
   *
   * One switch for the whole plate rather than one per seat: the operator should
   * decide what KIND of sign this is once. A static seat shows no state either
   * way — it has none — and its band simply omits the line rather than reserving
   * an empty one, which would read as a fault beside three filled ones.
   */
  showStatus: z.boolean().default(false),
  /**
   * Colour of the header bar, as a CLASS marker.
   *
   * Six-colour panels can distinguish a meeting room from an office at a glance,
   * from further away than any text is legible. Restricted to the panel's own
   * pigments and ignored on a panel without them, since a colour that is not in
   * the palette snaps to whichever entry happens to be nearest and would put the
   * header text on an unpredictable ground.
   */
  accentColor: z.enum(["none", "red", "blue", "green", "yellow"]).default("none"),
  /**
   * Whether to show a booking QR code, and when.
   *
   * Shown only for a plate with exactly ONE calendar seat that carries a booking
   * link. A single code on a four-desk plate cannot say which desk it books, and
   * an ambiguous action is worse than none.
   */
  bookingQr: z.enum(BOOKING_QR_VISIBILITIES).default("never"),
  locale: z.string().default("de"),
  /** Falls back to the display's zone, like every other renderer. */
  timezone: z.string().optional(),
});

export type NamePlateConfig = z.infer<typeof namePlateConfigSchema>;

/** True when anything on this plate can actually have a booking state. */
export function hasCalendarSeat(config: NamePlateConfig): boolean {
  return config.seats.some((s) => s.occupant.kind === "calendar");
}

/**
 * The room to put in the header, or null for no header at all.
 *
 * Prefers what the operator typed. Otherwise, if every calendar seat names the
 * same parent room, that is unambiguous and worth using — a plate whose seats all
 * come from "S1 2er Flexbüro Föhr" is a sign for that room. Seats from different
 * rooms name none, because guessing one would be wrong on the display.
 */
export function resolveRoomName(config: NamePlateConfig): string | null {
  const typed = config.roomName.trim();
  if (typed) return typed;

  const parents = new Set(
    config.seats
      .map((s) => (s.occupant.kind === "calendar" ? s.occupant.parentName?.trim() : undefined))
      .filter((n): n is string => !!n)
  );
  return parents.size === 1 ? [...parents][0] : null;
}

/**
 * How far a plate can be read, by seat count, on a 7.5" panel.
 *
 * Measured, not estimated: rendered through this renderer's own fit at
 * 800 x 480 with a 0.204 mm pixel pitch, taking the surname rank's cap height and
 * the distance at which it subtends 17 arcminutes (the signage rule of thumb,
 * height = distance / 200).
 *
 * Shown in the editor because the seat count is the single biggest decision an
 * operator makes about a plate, and today it is made blind. Four desks on one
 * door is a legitimate choice; believing it reads from down the corridor is not.
 *
 * The two-seat figure includes the narrow cut, which wins there because the width
 * binds. At three and four seats the HEIGHT binds and the narrow cut buys nothing,
 * which is why those two numbers did not move when it was installed.
 */
export const READING_DISTANCE_M: Record<number, number> = {
  1: 3.7,
  2: 3.0,
  3: 2.0,
  4: 1.4,
};
