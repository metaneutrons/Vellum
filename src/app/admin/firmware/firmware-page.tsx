"use client";

import { useState, useTransition } from "react";
import { updateFirmwareChannel, refreshFirmwareManifest, updateDevice } from "../actions";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";

interface Channel {
  id: string;
  name: string;
  manifestUrl: string;
  manifestCache: unknown;
  cachedAt: Date | null;
}

interface Device {
  mac: string;
  firmwareChannelId: string | null;
  firmwarePinVersion: string | null;
  displayCaps: unknown;
}

interface Props {
  channels: Channel[];
  devices: Device[];
}

export function FirmwarePage({ channels, devices }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [editingUrl, setEditingUrl] = useState<Record<string, string>>({});

  // Collect all available versions from channel manifests
  const availableVersions = [...new Set(
    channels
      .map((ch) => (ch.manifestCache as { version?: string } | null)?.version)
      .filter(Boolean) as string[]
  )].sort().reverse();

  function saveUrl(id: string) {
    const url = editingUrl[id];
    if (!url) return;
    startTransition(async () => {
      try { await updateFirmwareChannel(id, url); toast("success", "Channel updated"); }
      catch { toast("error", "Failed to assign channel"); }
    });
  }

  function refresh(id: string) {
    startTransition(async () => {
      try { await refreshFirmwareManifest(id); toast("success", "Manifest refresh triggered"); }
      catch { toast("error", "Failed to refresh"); }
    });
  }

  function assignChannel(mac: string, channelId: string | null) {
    startTransition(async () => {
      try { await updateDevice(mac, { firmwareChannelId: channelId }); toast("success", "Updated"); }
      catch { toast("error", "Failed to update firmware settings"); }
    });
  }

  function pinVersion(mac: string, version: string | null) {
    startTransition(async () => {
      try { await updateDevice(mac, { firmwarePinVersion: version }); toast("success", "Updated"); }
      catch { toast("error", "Failed to update firmware settings"); }
    });
  }

  return (
    <div className={pending ? "opacity-60 pointer-events-none" : ""}>
      <PageHeader title="Firmware" description="Manage OTA firmware updates and channels" actions={<a href="/admin/firmware/flash" className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">Flash Device</a>} />

      {/* Channels */}
      <h2 className="text-lg font-semibold mb-3">Channels</h2>
      <div className="bg-white rounded-lg shadow divide-y mb-8">
        {channels.map((ch) => {
          const manifest = ch.manifestCache as { version?: string; date?: string; binaries?: Record<string, unknown> } | null;
          return (
            <div key={ch.id} className="px-4 py-4">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{ch.name}</span>
                  {manifest?.version && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">v{manifest.version}</span>
                  )}
                  {manifest?.binaries && (
                    <span className="text-xs text-gray-500">
                      {Object.keys(manifest.binaries).join(", ")}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => refresh(ch.id)}>Refresh</Button>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  className="flex-1 text-xs border rounded px-2 py-1.5 font-mono"
                  aria-label="Manifest URL" value={editingUrl[ch.id] ?? ch.manifestUrl}
                  onChange={(e) => setEditingUrl((u) => ({ ...u, [ch.id]: e.target.value }))}
                />
                {editingUrl[ch.id] && editingUrl[ch.id] !== ch.manifestUrl && (
                  <Button size="sm" onClick={() => saveUrl(ch.id)}>Save</Button>
                )}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {ch.cachedAt ? `Cached: ${new Date(ch.cachedAt).toLocaleString("de-DE")}` : "Not cached yet"}
              </div>
            </div>
          );
        })}
      </div>

      {/* Device assignments */}
      <h2 className="text-lg font-semibold mb-3">Device Firmware Assignments</h2>
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Device</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Channel</th>
              <th className="px-4 py-3 font-medium">Pin Version</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.map((d) => {
              const caps = d.displayCaps as { model?: string } | null;
              return (
                <tr key={d.mac} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs"><a href={`/admin/devices/${d.mac}`} className="text-blue-600 hover:underline">{d.mac}</a></td>
                  <td className="px-4 py-3 text-xs text-gray-500">{caps?.model ?? "—"}</td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Firmware channel" value={d.firmwareChannelId ?? ""}
                      onChange={(e) => assignChannel(d.mac, e.target.value || null)}>
                      <option value="">stable (default)</option>
                      {channels.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Pin version"
                      value={d.firmwarePinVersion ?? ""}
                      onChange={(e) => pinVersion(d.mac, e.target.value || null)}>
                      <option value="">— latest —</option>
                      {availableVersions.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
