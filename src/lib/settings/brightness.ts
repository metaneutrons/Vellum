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
 * Historical profiles had a second schedule nested below brightness. Version 2
 * deliberately uses the profile's ordinary phases for cadence, brightness and
 * power together: one clock, one ordering rule and one place to diagnose.
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
  /** Legacy rule applied to both power sources. */
  percent: z.number().int().min(0).max(100).optional(),
  usbPercent: z.number().int().min(0).max(100).optional(),
  batteryPercent: z.number().int().min(0).max(100).optional(),
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
  const source = config as Record<string, unknown>;
  const raw = source.brightness;
  const result = brightnessPolicySchema.safeParse(raw ?? {});
  let base = result.success ? result.data : DEFAULT_BRIGHTNESS;

  /* Version 3 makes the source-specific ordinary behaviour self-contained.
   * The legacy brightness object remains synchronized for rollback safety, but
   * defaults is the canonical source on current servers. */
  if (source.version === 3 && source.defaults && typeof source.defaults === "object") {
    const defaults = source.defaults as Record<string, unknown>;
    const usb = defaults.usb as Record<string, unknown> | undefined;
    const battery = defaults.battery as Record<string, unknown> | undefined;
    const usbPercent = usb?.brightnessPercent;
    const batteryPercent = battery?.brightnessPercent;
    if (
      typeof usbPercent === "number" &&
      Number.isInteger(usbPercent) &&
      usbPercent >= 0 &&
      usbPercent <= 100 &&
      typeof batteryPercent === "number" &&
      Number.isInteger(batteryPercent) &&
      batteryPercent >= 0 &&
      batteryPercent <= 100
    ) {
      base = { ...base, usbPercent, batteryPercent };
    }
  }

  /* Version-2 profiles use the ordinary profile phases as the only clock. The
   * legacy nested schedule remains readable so existing rows behave identically
   * until an operator saves them in the new editor. */
  if ((source.version === 2 || source.version === 3) && Array.isArray(source.schedule)) {
    const schedule: BrightnessRule[] = [];
    for (const candidate of source.schedule) {
      if (!candidate || typeof candidate !== "object") continue;
      const phase = candidate as Record<string, unknown>;
      const usb = phase.usb as Record<string, unknown> | undefined;
      const battery = phase.battery as Record<string, unknown> | undefined;
      const parsed = brightnessRuleSchema.safeParse({
        name: phase.name,
        days: phase.days,
        startHour: phase.startHour,
        endHour: phase.endHour,
        usbPercent: usb?.brightnessPercent,
        batteryPercent: battery?.brightnessPercent,
      });
      if (parsed.success) {
        schedule.push(parsed.data);
      }
    }
    return { ...base, schedule };
  }
  return base;
}

export interface BrightnessContext {
  policy?: BrightnessPolicy | null;
  powerSource: "usb" | "battery";
  now: Date;
  /** The display's zone. Absent falls back to the server clock, as elsewhere. */
  timezone?: string | undefined;
  /** An operator's value for this one display, which outranks everything. */
  override?: number | null;
}

export type BrightnessTier = "device-override" | "schedule" | "power-default";

export interface BrightnessResult {
  percent: number;
  tier: BrightnessTier;
  /** Name of the rule that matched, when one did. */
  rule?: string | undefined;
}

function matches(rule: BrightnessRule, now: Date, timezone?: string): boolean {
  const zoned = timezone ? new TZDate(now, timezone) : now;
  const day = zoned.getDay();
  const hour = zoned.getHours();
  if (rule.startHour === rule.endHour) {
    return rule.days.length === 0 || rule.days.includes(day);
  }
  if (rule.startHour < rule.endHour) {
    return (
      (rule.days.length === 0 || rule.days.includes(day)) &&
      hour >= rule.startHour &&
      hour < rule.endHour
    );
  }
  const phaseDay = hour < rule.endHour ? (day + 6) % 7 : day;
  if (rule.days.length > 0 && !rule.days.includes(phaseDay)) return false;
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
      const percent =
        ctx.powerSource === "usb"
          ? (rule.usbPercent ?? rule.percent)
          : (rule.batteryPercent ?? rule.percent);
      if (percent != null) {
        return { percent, tier: "schedule", rule: rule.name || undefined };
      }
      /* First matching phase wins for the whole policy. An omitted brightness
       * value means inherit the power default, never continue into a lower
       * priority overlapping phase. */
      break;
    }
  }

  return {
    percent: ctx.powerSource === "usb" ? policy.usbPercent : policy.batteryPercent,
    tier: "power-default",
  };
}
