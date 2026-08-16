// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Shared validation and display rules for public room-booking QR codes. */

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
