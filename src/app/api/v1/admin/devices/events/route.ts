// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { requestHasPermission } from "@/lib/access";
import { subscribeDeviceEvents } from "@/lib/device-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

export async function GET(request: Request) {
  if (!(await requestHasPermission(request, "devices.read")))
    return Response.json({ error: "Forbidden" }, { status: 403 });

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: object) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      // A reconnect may have missed non-durable NOTIFY messages. Force one full
      // authoritative snapshot before accepting deltas.
      send({ type: "sync" });
      const unsubscribe = subscribeDeviceEvents(send);
      const heartbeat = setInterval(
        () => !closed && controller.enqueue(encoder.encode(": keepalive\n\n")),
        15_000
      );
      heartbeat.unref?.();

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // The browser may already have closed the stream.
        }
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
