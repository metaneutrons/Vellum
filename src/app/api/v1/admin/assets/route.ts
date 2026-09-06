// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { db, withDbRead } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { UUID_RE } from "@/lib/validation";
import {
  getRequestPrincipal,
  hasPermission,
  insertedRow,
  requestHasPermission,
  withAuditedTransaction,
} from "@/lib/access";
import { checkMutationOrigin } from "@/lib/request-origin";
import { log } from "@/lib/logger";
import { env } from "@/lib/env";

const MAX_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/svg+xml", "image/jpeg"];
const DEFAULT_LIMIT = 50;

/* One place for both handlers here, so a future third cannot forget the log. */
function originAccepted(request: Request, publicUrl: string | undefined, allowMissing: boolean) {
  const verdict = checkMutationOrigin(request, publicUrl, allowMissing);
  if (!verdict.ok) {
    log.warn("Refused mutation on origin", {
      route: "assets",
      reason: verdict.reason,
      expected: verdict.expected,
      received: verdict.received,
      derivedFromHost: verdict.derivedFromHost,
    });
  }
  return verdict.ok;
}

export async function GET(request: NextRequest) {
  if (!(await requestHasPermission(request, "content.read")))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "") || DEFAULT_LIMIT,
    200
  );
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "") || 0;

  const rows = await withDbRead(
    () =>
      db
        .select({
          id: assets.id,
          name: assets.name,
          mimeType: assets.mimeType,
          width: assets.width,
          height: assets.height,
          createdAt: assets.createdAt,
        })
        .from(assets)
        .orderBy(assets.createdAt)
        .limit(limit)
        .offset(offset),
    "list-assets"
  );

  return Response.json(rows);
}

export async function POST(request: Request) {
  const principal = await getRequestPrincipal(request);
  if (!principal || !hasPermission(principal, "content.manage"))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!originAccepted(request, env.VELLUM_PUBLIC_URL, principal.type !== "user"))
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const name = (formData.get("name") as string) || file?.name || "untitled";

  if (!file) return Response.json({ error: "No file provided" }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Response.json(
      { error: `Unsupported type: ${file.type}. Allowed: ${ALLOWED_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (file.size > MAX_SIZE_BYTES) {
    return Response.json(
      { error: `File too large (max ${MAX_SIZE_BYTES / 1024}KB)` },
      { status: 400 }
    );
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

  const rows = await withAuditedTransaction(
    principal,
    (created: { id: string }[]) => ({
      action: "asset.create",
      targetType: "asset",
      targetId: insertedRow(created, "asset").id,
      metadata: { name, mimeType: file.type, width, height },
    }),
    (tx) =>
      tx
        .insert(assets)
        .values({ name, mimeType: file.type, width, height, data: buffer })
        .returning({ id: assets.id }),
    "insert-asset"
  );

  const row = insertedRow(rows, "asset");
  return Response.json({ id: row.id, name, mimeType: file.type, width, height }, { status: 201 });
}

export async function DELETE(request: Request) {
  const principal = await getRequestPrincipal(request);
  if (!principal || !hasPermission(principal, "content.manage"))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!originAccepted(request, env.VELLUM_PUBLIC_URL, principal.type !== "user"))
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id || !UUID_RE.test(id))
    return Response.json({ error: "Invalid or missing id" }, { status: 400 });

  try {
    await withAuditedTransaction(
      principal,
      { action: "asset.delete", targetType: "asset", targetId: id },
      async (tx) => {
        const deleted = await tx
          .delete(assets)
          .where(eq(assets.id, id))
          .returning({ id: assets.id });
        if (deleted.length === 0) throw new Error("asset_not_found");
      },
      "delete-asset"
    );
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return Response.json({ error: "Asset is still used by content" }, { status: 409 });
    }
    throw error;
  }
  return new Response(null, { status: 204 });
}

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return (
    candidate.code === "23503" ||
    candidate.code === "23001" ||
    candidate.cause?.code === "23503" ||
    candidate.cause?.code === "23001"
  );
}
