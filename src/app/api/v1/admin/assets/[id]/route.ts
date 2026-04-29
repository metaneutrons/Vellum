// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(asset.data), {
    headers: {
      "Content-Type": asset.mimeType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}
