// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type LiveDeviceRow = Record<string, unknown> & { mac: string };
export type DeviceLiveState = "connecting" | "live" | "reconnecting";

/** Merge authoritative rows without reordering cards already on screen. */
export function mergeDeviceRows(
  current: LiveDeviceRow[],
  incoming: LiveDeviceRow[],
  requestedMacs: ReadonlySet<string> | null
): LiveDeviceRow[] {
  const byMac = new Map(incoming.map((device) => [device.mac, device]));
  const known = new Set(current.map((device) => device.mac));
  const retained = current.flatMap((device) => {
    const replacement = byMac.get(device.mac);
    if (replacement) return [replacement];
    if (requestedMacs === null || requestedMacs.has(device.mac)) return [];
    return [device];
  });
  const added = incoming.filter((device) => !known.has(device.mac));
  return [...added, ...retained];
}

export function useDeviceLiveUpdates(initialDevices: LiveDeviceRow[]) {
  const [devices, setDevices] = useState(initialDevices);

  /* Adopt server-rendered rows on every re-render, not just on mount.
   *
   * useState seeds once and ignores later props, so a server action's
   * revalidatePath() never reached this table: the page re-rendered with the new
   * row, the hook kept the old one, and a controlled <select value={row…}> snapped
   * straight back to the pre-action value even though the write had succeeded.
   * The value only looked right after a full reload, which mounts the hook afresh.
   *
   * The live channel does eventually repair it — the devices trigger notifies,
   * the SSE stream sends `changed`, and refresh() fetches the row about 250 ms
   * later — but that is a visible flash of stale state, and it becomes a lasting
   * wrong value whenever the stream cannot connect, leaving the 60 s fallback poll
   * as the only cure.
   *
   * Merged rather than assigned, so adopting authoritative data does not reorder
   * cards that are already on screen — the same reason refresh() merges. */
  useEffect(() => {
    setDevices((current) => {
      const merged = mergeDeviceRows(current, initialDevices, null);
      /* Return the identical reference when nothing actually changed, so React
       * skips the re-render. That is not just an optimisation: this effect keys on
       * the prop's identity, so a caller building the array inline would hand it a
       * fresh identity on every render and, without this bail-out, each pass would
       * set state, trigger another render and re-run forever. Compared by content
       * because the rows are freshly deserialised objects every time, which makes
       * reference comparison useless here. */
      return JSON.stringify(merged) === JSON.stringify(current) ? current : merged;
    });
  }, [initialDevices]);
  const [now, setNow] = useState(() => Date.now());
  const [state, setState] = useState<DeviceLiveState>("connecting");
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingMacs = useRef(new Set<string>());
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback((macs?: readonly string[]) => {
    const requested = macs ? new Set(macs) : null;
    queue.current = queue.current
      .catch(() => undefined)
      .then(async () => {
        const params = new URLSearchParams();
        for (const mac of macs ?? []) params.append("mac", mac);
        const queryString = params.toString();
        const query = queryString ? `?${queryString}` : "";
        const response = await fetch(`/api/v1/admin/devices/snapshot${query}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Device snapshot failed: ${response.status}`);
        const body = (await response.json()) as { devices?: LiveDeviceRow[] };
        if (!Array.isArray(body.devices)) throw new Error("Invalid device snapshot");
        const incoming = body.devices;
        setDevices((current) => mergeDeviceRows(current, incoming, requested));
        setNow(Date.now());
      })
      .catch(() => setState("reconnecting"));
    return queue.current;
  }, []);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    const fallback = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);

    const flushPending = () => {
      batchTimer.current = null;
      const macs = [...pendingMacs.current];
      pendingMacs.current.clear();
      if (macs.length > 0) void refresh(macs);
    };
    const source = new EventSource("/api/v1/admin/devices/events");
    source.onopen = () => setState("connecting");
    source.onerror = () => setState("reconnecting");
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as {
          type?: string;
          mac?: string;
          status?: DeviceLiveState;
        };
        if (event.type === "sync") {
          void refresh();
        } else if (
          event.type === "status" &&
          (event.status === "live" || event.status === "reconnecting")
        ) {
          setState(event.status);
        } else if (event.type === "changed" && event.mac) {
          pendingMacs.current.add(event.mac);
          if (!batchTimer.current) batchTimer.current = setTimeout(flushPending, 250);
        }
      } catch {
        // Ignore malformed events; the periodic authoritative sync repairs state.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);

    return () => {
      clearInterval(clock);
      clearInterval(fallback);
      if (batchTimer.current) clearTimeout(batchTimer.current);
      source.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [refresh]);

  return { devices, now, state };
}
