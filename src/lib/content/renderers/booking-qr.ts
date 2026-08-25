// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Shared validation and display rules for public room-booking QR codes. */

import QRCode from "qrcode";
import type { SKRSContext2D } from "@napi-rs/canvas";

export const BOOKING_QR_VISIBILITIES = ["never", "always", "free"] as const;
export type BookingQrVisibility = (typeof BOOKING_QR_VISIBILITIES)[number];

/**
 * Booking URLs are public payloads. Restricting them to HTTP(S), limiting their
 * length and normalising them at the boundary keeps the QR encoder predictable
 * and prevents malformed values from reaching display rendering.
 */
export function normalizeBookingUrl(value: string | null | undefined): string | null {
  // At the target e-paper resolutions, longer payloads become too dense for a
  // reliably scannable QR code at the reserved on-screen size.
  if (!value || value.length > 256) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function shouldShowBookingQr(
  visibility: BookingQrVisibility,
  isRoomFree: boolean,
  bookingUrl: string | null
): boolean {
  if (!bookingUrl || visibility === "never") return false;
  return visibility === "always" || isRoomFree;
}

/**
 * Draw a QR matrix, quiet zone included, into a square of at most `box` pixels.
 *
 * Returns the size actually drawn, which is `box` rounded DOWN to a whole number
 * of modules. Rounding down rather than scaling is the point: a module drawn at a
 * fractional size lands on different pixel counts across the matrix, and a
 * scanner reading an e-paper panel at an angle has no margin for that. The white
 * quiet zone is part of the code, not a decorative card.
 *
 * Hard-coded black on white rather than theme colours, for the same reason: a QR
 * code is a machine-readable object with a contrast requirement, not a piece of
 * the visual design. On a two-colour panel both values are exact palette entries.
 *
 * NOTE: `room-booking.ts` still has its own copy of this arithmetic inside
 * `renderBookingQr`, which also does that renderer's panel layout and label.
 * Unifying the two is on ROADMAP.md; it was left alone here rather than
 * refactoring a shipped renderer as a side effect of building a different one.
 */
export function drawQrMatrix(
  ctx: SKRSContext2D,
  url: string,
  x: number,
  y: number,
  box: number
): number {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const quietZone = 4;
  const modules = qr.modules.size + quietZone * 2;
  const moduleSize = Math.max(1, Math.floor(box / modules));
  const size = moduleSize * modules;

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < qr.modules.size; row++) {
    for (let col = 0; col < qr.modules.size; col++) {
      if (qr.modules.get(row, col)) {
        ctx.fillRect(
          x + (col + quietZone) * moduleSize,
          y + (row + quietZone) * moduleSize,
          moduleSize,
          moduleSize
        );
      }
    }
  }
  return size;
}
