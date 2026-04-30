// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { UUID_RE } from "@/lib/validation";

const MAX_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/svg+xml", "image/jpeg"];
const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest) {
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "") || DEFAULT_LIMIT, 200);
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "") || 0;

  const rows = await db.select({
    id: assets.id,
    name: assets.name,
    mimeType: assets.mimeType,
    width: assets.width,
    height: assets.height,
    createdAt: assets.createdAt,
  }).from(assets).orderBy(assets.createdAt).limit(limit).offset(offset);

  return Response.json(rows);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const name = (formData.get("name") as string) || file?.name || "untitled";

  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Response.json({ error: `Unsupported type: ${file.type}. Allowed: ${ALLOWED_TYPES.join(", ")}` }, { status: 400 });
  }
  if (file.size > MAX_SIZE_BYTES) {
    return Response.json({ error: `File too large (max ${MAX_SIZE_BYTES / 1024}KB)` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let width: number | null = null;
  let height: number | null = null;

  if (file.type === "image/png" && buffer.length >= 24) {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (file.type === "image/jpeg" && buffer.length > 2) {
    // Proper JPEG marker parsing — skip by marker length, find SOF0/SOF2
    let i = 2; // skip SOI (0xFFD8)
    while (i < buffer.length - 9) {
      if (buffer[i] !== 0xff) break;
      const marker = buffer[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        height = buffer.readUInt16BE(i + 5);
        width = buffer.readUInt16BE(i + 7);
        break;
      }
      // Skip marker payload (length includes the 2 length bytes)
      const len = buffer.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }

  const [row] = await db.insert(assets).values({ name, mimeType: file.type, width, height, data: buffer })
    .returning({ id: assets.id });

  return Response.json({ id: row.id, name, mimeType: file.type, width, height }, { status: 201 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id || !UUID_RE.test(id)) return Response.json({ error: "Invalid or missing id" }, { status: 400 });

  await db.delete(assets).where(eq(assets.id, id));
  return new Response(null, { status: 204 });
}
