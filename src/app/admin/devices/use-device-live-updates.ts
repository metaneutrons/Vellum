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
