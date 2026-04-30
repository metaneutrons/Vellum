// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "Invalid asset ID" }, { status: 400 });

  const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset) return Response.json({ error: "Asset not found" }, { status: 404 });

  return new Response(new Uint8Array(asset.data), {
    headers: {
      "Content-Type": asset.mimeType,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Disposition": asset.mimeType === "image/svg+xml" ? "attachment" : "inline",
    },
  });
}
