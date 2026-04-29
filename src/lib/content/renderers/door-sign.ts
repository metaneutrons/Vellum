// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign content renderer — configurable name plate for rooms/desks.
 *
 * Renders a background image with positioned text boxes filled from
 * anny booking data (customer, resource properties). Supports per-display
 * design overrides for different aspect ratios.
 */

import { z } from "zod";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, dataProviders } from "@/db/schema";
import { decryptCredentials } from "@/lib/encryption";
import { extractOrgFromToken, annyCredentialSchema, annyRoomConfigSchema } from "@/lib/calendar/providers/anny";
import { log } from "@/lib/logger";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";

/* ── Schema ───────────────────────────────────────────────────── */

const textBoxSchema = z.object({
  id: z.string(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
  template: z.string(),
  fontSize: z.number().min(0.01).max(0.5), // relative to height
  align: z.enum(["left", "center", "right"]).default("center"),
  color: z.string().default("#000000"),
  bold: z.boolean().default(false),
});

const designSchema = z.object({
  backgroundAssetId: z.string().uuid().nullable().default(null),
  textBoxes: z.array(textBoxSchema).default([]),
  freeTextBoxes: z.array(textBoxSchema).default([]),
  backgroundColor: z.string().default("#FFFFFF"),
});

export const doorSignConfigSchema = z.object({
  providerId: z.string().uuid(),
  resourceId: z.string(),
  resourceName: z.string().optional(),
  locale: z.string().default("de"),
  timezone: z.string().default("Europe/Berlin"),
  // Default design (used when no size-specific override matches)
  design: designSchema,
  // Per-display-size overrides: key = "WxH" (e.g. "800x480")
  designOverrides: z.record(z.string(), designSchema).default({}),
});

export type DoorSignConfig = z.infer<typeof doorSignConfigSchema>;
export type TextBox = z.infer<typeof textBoxSchema>;
type Design = z.infer<typeof designSchema>;

/* ── Template variable resolution ─────────────────────────────── */

interface BookingContext {
  title?: string;
  given_name?: string;
  family_name?: string;
  full_name?: string;
  company?: string;
  email?: string;
  booking_description?: string;
  booking_note?: string;
  start?: string;
  end?: string;
  date?: string;
  resource_name?: string;
  [key: string]: string | undefined; // prop.* and custom.*
}

function resolveTemplate(template: string, ctx: BookingContext): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const val = ctx[key] ?? ctx[key.replace("prop.", "")] ?? "";
    return String(val);
  }).replace(/\s{2,}/g, " ").trim();
}

/* ── Fetch current booking from anny ──────────────────────────── */

interface CurrentBooking {
  customerTitle?: string;
  customerGivenName?: string;
  customerFamilyName?: string;
  customerFullName?: string;
  customerCompany?: string;
  customerEmail?: string;
  description?: string;
  note?: string;
  startDate: Date;
  endDate: Date;
}

async function fetchCurrentBooking(
  apiToken: string,
  orgId: string,
  resourceId: string,
  now: Date,
): Promise<CurrentBooking | null> {
  const ANNY_BASE = "https://b.anny.co/api/v1";
  const today = now.toISOString().split("T")[0];

  const url = new URL(`${ANNY_BASE}/bookings`);
  url.searchParams.set("o", orgId);
  url.searchParams.set("filter[resource_id]", resourceId);
  url.searchParams.set("filter[date_from]", today);
  url.searchParams.set("filter[date_to]", today);
  url.searchParams.set("filter[status]", "accepted");
  url.searchParams.set("include", "customer");
  url.searchParams.set("page[size]", "20");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return null;
  const data = await res.json();

  // Build customer map
  const customers = new Map<string, Record<string, unknown>>();
  for (const inc of (data.included ?? []) as { id: string; type: string; attributes: Record<string, unknown> }[]) {
    if (inc.type === "customers") customers.set(inc.id, inc.attributes);
  }

  // Find booking that covers "now"
  for (const b of (data.data ?? []) as { attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string } | null }> }[]) {
    const start = new Date(b.attributes.start_date as string);
    const end = new Date(b.attributes.end_date as string);
    if (now >= start && now < end) {
      const custId = b.relationships?.customer?.data?.id;
      const cust = custId ? customers.get(custId) : undefined;
      return {
        customerTitle: cust?.title as string | undefined,
        customerGivenName: cust?.given_name as string | undefined,
        customerFamilyName: cust?.family_name as string | undefined,
        customerFullName: cust?.full_name as string | undefined,
        customerCompany: cust?.company as string | undefined,
        customerEmail: cust?.email as string | undefined,
        description: b.attributes.description as string | undefined,
        note: b.attributes.note as string | undefined,
        startDate: start,
        endDate: end,
      };
    }
  }

  return null;
}

/* ── Fetch resource properties ────────────────────────────────── */

async function fetchResourceProperties(
  apiToken: string,
  orgId: string,
  resourceId: string,
): Promise<Record<string, string>> {
  const ANNY_BASE = "https://b.anny.co/api/v1";
  const url = new URL(`${ANNY_BASE}/resource-properties`);
  url.searchParams.set("o", orgId);
  url.searchParams.set("include", "property");
  url.searchParams.set("page[size]", "200");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return {};
  const data = await res.json();

  // Build property label map
  const propLabels = new Map<string, string>();
  for (const inc of (data.included ?? []) as { id: string; type: string; attributes: { label?: string } }[]) {
    if (inc.type === "properties" && inc.attributes.label) {
      propLabels.set(inc.id, inc.attributes.label);
    }
  }

  // Match resource-properties to this resource (we can't filter by resource_id via API)
  // For now, return all properties — the template will only use what it references
  const props: Record<string, string> = {};
  for (const rp of (data.data ?? []) as { attributes: { value: unknown }; relationships?: { property?: { data?: { id: string } } } }[]) {
    const propId = rp.relationships?.property?.data?.id;
    const label = propId ? propLabels.get(propId) : undefined;
    if (label && rp.attributes.value != null) {
      props[`prop.${label}`] = String(rp.attributes.value);
    }
  }

  return props;
}

/* ── Render ───────────────────────────────────────────────────── */

function selectDesign(config: DoorSignConfig, width: number, height: number): Design {
  const key = `${width}x${height}`;
  return config.designOverrides[key] ?? config.design;
}

function formatTime(date: Date, timezone: string): string {
  return date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
}

async function renderDoorSign(
  config: DoorSignConfig,
  design: Design,
  ctx: BookingContext,
  isOccupied: boolean,
  width: number,
  height: number,
): Promise<Canvas> {
  const canvas = createCanvas(width, height);
  const c = canvas.getContext("2d");

  // Background
  if (design.backgroundAssetId) {
    const [asset] = await db.select().from(assets).where(eq(assets.id, design.backgroundAssetId)).limit(1);
    if (asset) {
      const img = await loadImage(asset.data);
      c.drawImage(img, 0, 0, width, height);
    } else {
      c.fillStyle = design.backgroundColor;
      c.fillRect(0, 0, width, height);
    }
  } else {
    c.fillStyle = design.backgroundColor;
    c.fillRect(0, 0, width, height);
  }

  // Select text boxes based on occupancy
  const boxes = isOccupied ? design.textBoxes : design.freeTextBoxes;

  // Render text boxes
  for (const box of boxes) {
    const text = resolveTemplate(box.template, ctx);
    if (!text) continue;

    const px = Math.round(box.x * width);
    const py = Math.round(box.y * height);
    const pw = Math.round(box.w * width);
    const ph = Math.round(box.h * height);
    const fs = Math.round(box.fontSize * height);

    c.fillStyle = box.color;
    c.font = `${box.bold ? "bold " : ""}${fs}px sans-serif`;
    c.textBaseline = "top";

    let tx: number;
    if (box.align === "center") {
      c.textAlign = "center";
      tx = px + pw / 2;
    } else if (box.align === "right") {
      c.textAlign = "right";
      tx = px + pw;
    } else {
      c.textAlign = "left";
      tx = px;
    }

    // Word wrap
    const words = text.split(" ");
    let line = "";
    let lineY = py;
    const lineHeight = fs * 1.2;

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      const metrics = c.measureText(test);
      if (metrics.width > pw && line) {
        c.fillText(line, tx, lineY);
        line = word;
        lineY += lineHeight;
        if (lineY + fs > py + ph) break; // overflow
      } else {
        line = test;
      }
    }
    if (line && lineY + fs <= py + ph) {
      c.fillText(line, tx, lineY);
    }
  }

  return canvas;
}

/* ── Renderer export ──────────────────────────────────────────── */

export const doorSignRenderer: ContentRenderer = {
  slug: "door-sign",
  name: "Door Sign (Türschild)",
  configSchema: doorSignConfigSchema,

  async render(params: RenderParams): Promise<RenderResult> {
    const config = doorSignConfigSchema.parse(params.config);
    const { width, height } = params.display;
    const design = selectDesign(config, width, height);

    // Fetch provider credentials
    const [provider] = await db.select().from(dataProviders).where(eq(dataProviders.id, config.providerId)).limit(1);
    if (!provider) throw new Error("Provider not found");

    const creds = decryptCredentials(provider.encryptedCredentials) as { apiToken: string; organizationId?: string };
    const orgId = creds.organizationId || extractOrgFromToken(creds.apiToken) || "";
    if (!orgId) throw new Error("Cannot determine anny organization ID");

    // Fetch current booking
    const booking = await fetchCurrentBooking(creds.apiToken, orgId, config.resourceId, params.now);
    const isOccupied = booking !== null;

    // Build template context
    const ctx: BookingContext = {
      resource_name: config.resourceName ?? "",
    };

    if (booking) {
      ctx.title = booking.customerTitle ?? "";
      ctx.given_name = booking.customerGivenName ?? "";
      ctx.family_name = booking.customerFamilyName ?? "";
      ctx.full_name = booking.customerFullName ?? "";
      ctx.company = booking.customerCompany ?? "";
      ctx.email = booking.customerEmail ?? "";
      ctx.booking_description = booking.description ?? "";
      ctx.booking_note = booking.note ?? "";
      ctx.start = formatTime(booking.startDate, config.timezone);
      ctx.end = formatTime(booking.endDate, config.timezone);
      ctx.date = booking.startDate.toLocaleDateString(config.locale, { weekday: "short", day: "numeric", month: "short", timeZone: config.timezone });
    }

    // Fetch resource properties (best-effort)
    try {
      const props = await fetchResourceProperties(creds.apiToken, orgId, config.resourceId);
      Object.assign(ctx, props);
    } catch (err) {
      log.warn("door-sign: failed to fetch resource properties", { error: String(err) });
    }

    const canvas = await renderDoorSign(config, design, ctx, isOccupied, width, height);
    return { canvas };
  },
};
