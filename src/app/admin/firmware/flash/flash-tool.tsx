"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";

interface Channel { id: string; name: string; manifestCache: unknown; }
interface Binary { url: string; sha256: string; size: number; }

export function FlashTool({ channels }: { channels: Channel[] }) {
  const [model, setModel] = useState("e1002");
  const [channel, setChannel] = useState(channels[0]?.name ?? "stable");
  const [status, setStatus] = useState("");
  const [flashing, setFlashing] = useState(false);

  const manifest = channels.find((c) => c.name === channel)?.manifestCache as {
    version?: string; binaries?: Record<string, Binary>;
  } | null;
  const binary = manifest?.binaries?.[model];

  async function flash() {
    if (!binary) return;
    setFlashing(true);
    setStatus("Downloading firmware...");
    try {
      const res = await fetch(binary.url);
      if (!res.ok) throw new Error("Download failed: " + res.status);
      const blob = await res.blob();
      const filename = binary.url.split("/").pop() ?? "firmware.bin";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatus("Downloaded " + filename + " (" + (binary.size / 1024).toFixed(0) + " KB).\n\nFlash with:\n  esptool.py --chip esp32s3 write_flash 0x0 " + filename + "\n\nOr use https://web.esphome.io");
    } catch (err) {
      setStatus("Error: " + err);
    } finally {
      setFlashing(false);
    }
  }

  return (
    <div>
      <Link href="/admin/firmware" className="text-sm text-blue-500 hover:underline mb-4 inline-block">← Back to Firmware</Link>
      <PageHeader title="Flash Firmware" description="Download firmware binary for manual flashing via USB" />
      <div className="bg-white rounded-lg shadow p-6 max-w-lg">
        <label className="block text-sm font-medium mb-1">Display Model</label>
        <select className="w-full border rounded px-3 py-2 mb-4 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="e1001">E1001 (7.5&quot; B&amp;W)</option>
          <option value="e1002">E1002 (7.3&quot; Color)</option>
          <option value="e1003">E1003 (10.3&quot; Mono)</option>
        </select>
        <label className="block text-sm font-medium mb-1">Channel</label>
        <select className="w-full border rounded px-3 py-2 mb-4 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        {manifest?.version && (
          <div className="text-sm mb-4">
            <span className="text-gray-500">Version:</span> <span className="font-mono font-medium">{manifest.version}</span>
            {binary && <span className="text-gray-500 ml-2">({(binary.size / 1024).toFixed(0)} KB)</span>}
          </div>
        )}
        {!binary && manifest && <div className="text-sm text-yellow-500 mb-4">No binary for {model} in this channel.</div>}
        <Button onClick={flash} disabled={!binary || flashing} pending={flashing}>Download Firmware</Button>
        {status && <pre className="mt-4 p-3 rounded-lg text-xs font-mono whitespace-pre-wrap" style={{ background: "#0d0d1a", color: "#4ade80" }}>{status}</pre>}
        <div className="mt-6 text-xs text-gray-500 space-y-1">
          <p>1. Download the firmware binary</p>
          <p>2. Connect device via USB-C</p>
          <p>3. Flash with esptool.py or web.esphome.io</p>
        </div>
      </div>
    </div>
  );
}
