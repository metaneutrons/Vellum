// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Backlight brightness: the second section of a display profile.
 *
 * Deliberately the same shape as the cadence section, because an operator should
 * learn one concept and not two that merely resemble each other:
 *
 *   TIERS for power. A fixed, small vocabulary — on USB, on battery — mirroring
 *   usbIntervalS and batteryIntervalS. A table you read.
 *
 *   RULES for time. Open-ended, with the same days / startHour / endHour shape as
 *   a cadence rule, wrapping past midnight the same way, and the same precedence:
 *   first match wins. An expression you debug, so it stays as small as possible.
 *
 * Two separate rule lists rather than one shared list with both fields, because a
 * night dimming window from 18:00 to 07:00 has no reason to coincide with a
 * polling window. Sharing the list would force operators to duplicate rules to
 * express the ordinary case.
 *
 * Evaluation happens on the server and the device receives a single number. That
 * keeps clock and timezone logic out of the firmware, and a schedule change takes
 * effect on the next poll instead of needing a push.
 */
import { z } from "zod";
import { TZDate } from "@date-fns/tz";

export const brightnessRuleSchema = z.object({
  name: z.string().default(""),
  /** Days this rule applies: 0=Sun … 6=Sat. Empty = all days. */
  days: z.array(z.number().int().min(0).max(6)).default([]),
  startHour: z.number().int().min(0).max(23),
  /** If < startHour, the rule wraps past midnight. */
  endHour: z.number().int().min(0).max(23),
  percent: z.number().int().min(0).max(100),
});
export type BrightnessRule = z.infer<typeof brightnessRuleSchema>;

export const brightnessPolicySchema = z.object({
  /* 80 matches what the firmware did unconditionally before this existed, so a
   * profile that says nothing changes nothing. */
  usbPercent: z.number().int().min(0).max(100).default(80),
  /* Dimmer on battery for the same reason the poll interval is longer: the
   * backlight is the largest continuous draw on an LCD panel. */
  batteryPercent: z.number().int().min(0).max(100).default(40),
  schedule: z.array(brightnessRuleSchema).default([]),
});
export type BrightnessPolicy = z.infer<typeof brightnessPolicySchema>;

export const DEFAULT_BRIGHTNESS: BrightnessPolicy = brightnessPolicySchema.parse({});

/**
 * A profile's `config` blob holds both sections. Parsed separately and
 * defensively: a profile written before brightness existed has no `brightness`
 * key, and must resolve to the built-in policy rather than to nothing.
 */
export function parseBrightnessPolicy(config: unknown): BrightnessPolicy {
  if (!config || typeof config !== "object") return DEFAULT_BRIGHTNESS;
  const raw = (config as Record<string, unknown>).brightness;
  const result = brightnessPolicySchema.safeParse(raw ?? {});
  return result.success ? result.data : DEFAULT_BRIGHTNESS;
}

export interface BrightnessContext {
  policy?: BrightnessPolicy | null;
  powerSource: "usb" | "battery";
  now: Date;
  /** The display's zone. Absent falls back to the server clock, as elsewhere. */
  timezone?: string;
  /** An operator's value for this one display, which outranks everything. */
  override?: number | null;
}

export type BrightnessTier = "device-override" | "schedule" | "power-default";

export interface BrightnessResult {
  percent: number;
  tier: BrightnessTier;
  /** Name of the rule that matched, when one did. */
  rule?: string;
}

function matches(rule: BrightnessRule, now: Date, timezone?: string): boolean {
  const zoned = timezone ? new TZDate(now, timezone) : now;
  const day = zoned.getDay();
  const hour = zoned.getHours();
  if (rule.days.length > 0 && !rule.days.includes(day)) return false;
  if (rule.startHour <= rule.endHour) return hour >= rule.startHour && hour < rule.endHour;
  return hour >= rule.startHour || hour < rule.endHour;
}

export function evaluateBrightness(ctx: BrightnessContext): BrightnessResult {
  /* An explicit per-display value wins outright, including over a schedule. An
   * operator who set a lobby to 100 means it at 23:00 too; anything else makes
   * the override look broken at exactly the hour they were testing. */
  if (ctx.override != null) {
    return { percent: Math.min(Math.max(ctx.override, 0), 100), tier: "device-override" };
  }

  const policy = ctx.policy ?? DEFAULT_BRIGHTNESS;

  for (const rule of policy.schedule) {
    if (matches(rule, ctx.now, ctx.timezone)) {
      return { percent: rule.percent, tier: "schedule", rule: rule.name || undefined };
    }
  }

  return {
    percent: ctx.powerSource === "usb" ? policy.usbPercent : policy.batteryPercent,
    tier: "power-default",
  };
}
