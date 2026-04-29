// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";

const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_TYPES = ["image/png", "image/svg+xml", "image/jpeg"];

export async function GET() {
  const rows = await db.select({
    id: assets.id,
    name: assets.name,
    mimeType: assets.mimeType,
    width: assets.width,
    height: assets.height,
    createdAt: assets.createdAt,
  }).from(assets).orderBy(assets.createdAt);

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
  const data = buffer.toString("base64");

  let width: number | null = null;
  let height: number | null = null;

  if (file.type === "image/png" || file.type === "image/jpeg") {
    // Extract dimensions from PNG/JPEG header
    if (file.type === "image/png" && buffer.length >= 24) {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    } else if (file.type === "image/jpeg") {
      // JPEG: scan for SOF marker
      for (let i = 0; i < buffer.length - 9; i++) {
        if (buffer[i] === 0xff && (buffer[i + 1] === 0xc0 || buffer[i + 1] === 0xc2)) {
          height = buffer.readUInt16BE(i + 5);
          width = buffer.readUInt16BE(i + 7);
          break;
        }
      }
    }
  }

  const [row] = await db.insert(assets).values({
    name,
    mimeType: file.type,
    width,
    height,
    data,
  }).returning({ id: assets.id });

  return Response.json({ id: row.id, name, mimeType: file.type, width, height }, { status: 201 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  await db.delete(assets).where(eq(assets.id, id));
  return new Response(null, { status: 204 });
}
