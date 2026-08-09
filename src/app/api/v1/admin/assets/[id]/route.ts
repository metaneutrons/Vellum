// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db, withDb } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { UUID_RE } from "@/lib/validation";
import { requestHasPermission } from "@/lib/access";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requestHasPermission(request, "content.read"))) return Response.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "Invalid asset ID" }, { status: 400 });

  const [asset] = await withDb(() => db.select().from(assets).where(eq(assets.id, id)).limit(1), "get-asset-by-id");
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
