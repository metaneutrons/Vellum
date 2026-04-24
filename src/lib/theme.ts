/**
 * Theme system — Single Source of Truth for display branding.
 */

import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const themeSchema = z.object({
  name: z.string(),
  headerBg: hexColor,
  headerText: hexColor,
  freeBadge: hexColor,
  busyBadge: hexColor,
  badgeText: hexColor,
  background: hexColor,
  slotBg: hexColor,
  slotText: hexColor,
  slotSecondary: hexColor,
  footerText: hexColor,
});

export type Theme = z.infer<typeof themeSchema>;

/** Safely parse a JSONB value into a Theme, returning null on failure. */
export function parseTheme(raw: unknown): Theme | null {
  const result = themeSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export const THEME_LEXICT: Theme = {
  name: "lexICT",
  headerBg: "#000000",
  headerText: "#FFFFFF",
  freeBadge: "#008000",
  busyBadge: "#FF0000",
  badgeText: "#FFFFFF",
  background: "#FFFFFF",
  slotBg: "#000000",
  slotText: "#FFFFFF",
  slotSecondary: "#000000",
  footerText: "#000000",
};

export const THEME_MONO: Theme = {
  name: "Mono",
  headerBg: "#000000",
  headerText: "#FFFFFF",
  freeBadge: "#FFFFFF",
  busyBadge: "#000000",
  badgeText: "#FFFFFF",
  background: "#FFFFFF",
  slotBg: "#DDDDDD",
  slotText: "#000000",
  slotSecondary: "#888888",
  footerText: "#888888",
};

export function resolveTheme(colorCount: number): Theme {
  return colorCount > 2 ? THEME_LEXICT : THEME_MONO;
}
