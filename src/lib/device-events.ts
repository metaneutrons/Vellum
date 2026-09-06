// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { PoolClient } from "pg";
import { acquireDbListener } from "@/db";
import { log } from "@/lib/logger";

const CHANNEL = "vellum_device_events";
const RECONNECT_MS = 2_000;

export type DeviceEvent =
  { type: "changed"; mac: string } | { type: "status"; status: "live" | "reconnecting" };

type Listener = (event: DeviceEvent) => void;

class DeviceEventHub {
  private listeners = new Set<Listener>();
  private client: PoolClient | null = null;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({
      type: "status",
      status: this.client ? "live" : "reconnecting",
    });
    void this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.client || this.connecting || this.listeners.size === 0) return;
    this.connecting = true;
    let acquired: PoolClient | null = null;
    try {
      const client = await acquireDbListener();
      acquired = client;
      if (this.listeners.size === 0) {
        client.release();
        acquired = null;
        return;
      }
      client.on("notification", this.onNotification);
      client.on("error", this.onError);
      client.on("end", this.onEnd);
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      acquired = null;
      this.publish({ type: "status", status: "live" });
      log.info("Device live-event listener connected");
    } catch (error) {
      acquired?.removeListener("notification", this.onNotification);
      acquired?.removeListener("error", this.onError);
      acquired?.removeListener("end", this.onEnd);
      acquired?.release(true);
      log.warn("Device live-event listener unavailable", { error: String(error) });
      this.publish({ type: "status", status: "reconnecting" });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private readonly onNotification = (message: {
    channel: string;
    payload?: string | undefined;
  }) => {
    if (message.channel !== CHANNEL || !message.payload) return;
    try {
      const event = JSON.parse(message.payload) as { mac?: unknown };
      if (typeof event.mac !== "string" || event.mac.length === 0) return;
      this.publish({ type: "changed", mac: event.mac });
    } catch (error) {
      log.warn("Ignored malformed device notification", { error: String(error) });
    }
  };

  private readonly onError = (error: Error) => {
    log.warn("Device live-event listener disconnected", { error: String(error) });
    this.dropClient();
    this.publish({ type: "status", status: "reconnecting" });
    this.scheduleReconnect();
  };

  private readonly onEnd = () => {
    this.dropClient();
    this.publish({ type: "status", status: "reconnecting" });
    this.scheduleReconnect();
  };

  private publish(event: DeviceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeListener("notification", this.onNotification);
    client.removeListener("error", this.onError);
    client.removeListener("end", this.onEnd);
    client.release(true);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.listeners.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, RECONNECT_MS);
    this.reconnectTimer.unref();
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (!client) return;
    client.removeListener("notification", this.onNotification);
    client.removeListener("error", this.onError);
    client.removeListener("end", this.onEnd);
    void client.query(`UNLISTEN ${CHANNEL}`).finally(() => client.release());
  }
}

const globalEvents = globalThis as typeof globalThis & {
  __vellumDeviceEventHub?: DeviceEventHub;
};

const hub = (globalEvents.__vellumDeviceEventHub ??= new DeviceEventHub());

export function subscribeDeviceEvents(listener: Listener): () => void {
  return hub.subscribe(listener);
}
