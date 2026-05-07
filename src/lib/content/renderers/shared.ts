// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Shared utilities for door-sign renderers.
 */

import { loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { TtlCache } from "@/lib/cache";
import { log } from "@/lib/logger";
import type { TextBox, Design } from "./door-sign-types";

/* ── Caches ───────────────────────────────────────────────────── */

const ASSET_CACHE_TTL_MS = 5 * 60_000;
export const assetCache = new TtlCache<Buffer>(ASSET_CACHE_TTL_MS);

/* ── Template variable resolution ─────────────────────────────── */

export interface TemplateContext {
  [key: string]: string | undefined;
}

export function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => ctx[key] ?? "")
    .replace(/\s{2,}/g, " ").trim();
}

/* ── Load background asset (cached) ──────────────────────────── */

export async function loadBackgroundAsset(assetId: string): Promise<Buffer | null> {
  const cached = assetCache.get(assetId);
  if (cached) return cached;

  const [asset] = await db.select({ data: assets.data }).from(assets)
    .where(eq(assets.id, assetId)).limit(1);
  if (!asset) return null;

  assetCache.set(assetId, asset.data);
  return asset.data;
}

/* ── Design selection by display size ─────────────────────────── */

export function selectDesign<T extends { design: Design; designOverrides: Record<string, Design> }>(
  config: T, width: number, height: number
): Design {
  return config.designOverrides[`${width}x${height}`] ?? config.design;
}

/* ── Time formatting ──────────────────────────────────────────── */

export function formatTime(date: Date, locale: string, timezone: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: timezone });
}

/* ── Render text boxes onto canvas ────────────────────────────── */

export function renderTextBoxes(c: SKRSContext2D, boxes: TextBox[], ctx: TemplateContext, width: number, height: number): void {
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
    c.textAlign = box.align === "center" ? "center" : box.align === "right" ? "right" : "left";

    const tx = box.align === "center" ? px + pw / 2 : box.align === "right" ? px + pw : px;

    // Word wrap
    const words = text.split(" ");
    let line = "";
    let lineY = py;
    const lineHeight = fs * 1.2;

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > pw && line) {
        c.fillText(line, tx, lineY);
        line = word;
        lineY += lineHeight;
        if (lineY + fs > py + ph) break;
      } else {
        line = test;
      }
    }
    if (line && lineY + fs <= py + ph) {
      c.fillText(line, tx, lineY);
    }
  }
}

/* ── Draw background (color + optional image) ─────────────────── */

export async function drawBackground(c: SKRSContext2D, design: Design, width: number, height: number): Promise<void> {
  c.fillStyle = design.backgroundColor;
  c.fillRect(0, 0, width, height);

  if (design.backgroundAssetId) {
    try {
      const buf = await loadBackgroundAsset(design.backgroundAssetId);
      if (buf) {
        const img = await loadImage(buf);
        c.drawImage(img, 0, 0, width, height);
      }
    } catch (err) {
      log.warn("door-sign: failed to load background image", { assetId: design.backgroundAssetId, error: String(err) });
    }
  }
}
