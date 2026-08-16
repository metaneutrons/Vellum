// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import { normalizeBookingUrl, shouldShowBookingQr } from "../booking-qr";

describe("booking QR safety and visibility", () => {
  it("accepts only bounded HTTP(S) booking URLs", () => {
    expect(normalizeBookingUrl("https://anny.co/b/book/team-room")).toBe(
      "https://anny.co/b/book/team-room"
    );
    expect(normalizeBookingUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBookingUrl("mailto:room@example.com")).toBeNull();
    expect(normalizeBookingUrl("not a url")).toBeNull();
    expect(normalizeBookingUrl(`https://example.com/${"a".repeat(257)}`)).toBeNull();
  });

  it("honours never, always and only-when-free independently of the URL source", () => {
    const url = "https://anny.co/b/book/team-room";
    expect(shouldShowBookingQr("never", true, url)).toBe(false);
    expect(shouldShowBookingQr("always", false, url)).toBe(true);
    expect(shouldShowBookingQr("free", true, url)).toBe(true);
    expect(shouldShowBookingQr("free", false, url)).toBe(false);
    expect(shouldShowBookingQr("always", true, null)).toBe(false);
  });
});
