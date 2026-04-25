"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";

interface Channel { id: string; name: string; manifestCache: unknown; }

export function FlashTool({ channels }: { channels: Channel[] }) {
  const [model, setModel] = useState("e1002");
  const [channel, setChannel] = useState(channels[0]?.name ?? "stable");
  const [loaded, setLoaded] = useState(false);

  const manifest = channels.find((c) => c.name === channel)?.manifestCache as {
    version?: string;
    binaries?: Record<string, { url: string; size: number }>;
  } | null;
  const binary = manifest?.binaries?.[model];

  const manifestUrl = `/api/v1/admin/flash-manifest?model=${model}&channel=${channel}`;

  // Load ESP Web Tools script
  useEffect(() => {
    if (loaded) return;
    const script = document.createElement("script");
    script.src = "https://unpkg.com/esp-web-tools@10/dist/web/install-button.js?module";
    script.type = "module";
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, [loaded]);

  return (
    <div>
      <Link href="/admin/firmware" className="text-sm text-blue-500 hover:underline mb-4 inline-block">← Back to Firmware</Link>
      <PageHeader title="Flash Firmware" description="Flash firmware directly from the browser via USB" />

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
            <span className="text-gray-500">Version:</span>{" "}
            <span className="font-mono font-medium">{manifest.version}</span>
            {binary && <span className="text-gray-500 ml-2">({(binary.size / 1024).toFixed(0)} KB)</span>}
          </div>
        )}

        {!manifest && (
          <div className="text-sm text-gray-500 mb-4">No manifest cached yet. Go to Firmware page and click Refresh on a channel first.</div>
        )}
        {!binary && manifest && (
          <div className="text-sm text-yellow-500 mb-4">No binary for {model} in this channel.</div>
        )}

        {/* ESP Web Tools install button */}
        <div className="mt-2" key={model + channel}>
          {binary ? (
            <div
              dangerouslySetInnerHTML={{
                __html: `<esp-web-install-button manifest="${manifestUrl}"><button slot="activate" style="width:100%;padding:10px 20px;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer">Connect &amp; Flash</button><span slot="unsupported"><div style="padding:12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:13px;color:#f59e0b">⚠ Web Serial not supported. Use Chrome or Edge.</div></span><span slot="not-allowed"><div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:13px;color:#f87171">⚠ Serial access denied. Check browser permissions.</div></span></esp-web-install-button>`,
              }}
            />
          ) : (
            <button disabled className="w-full py-2.5 bg-gray-600 text-white rounded-lg opacity-50 text-sm">
              No firmware available
            </button>
          )}
        </div>

        <div className="mt-6 text-xs text-gray-500 space-y-1">
          <p>1. Connect the device via USB-C cable</p>
          <p>2. Turn on the device (power switch on back)</p>
          <p>3. Click &quot;Connect &amp; Flash&quot; and select the serial port</p>
          <p>4. Wait for the flash to complete — do not disconnect</p>
        </div>

        <div className="mt-4 p-3 rounded-lg text-xs" style={{ background: "#0d0d1a", color: "#64748b" }}>
          Requires Chrome or Edge. The firmware binary is downloaded directly from GitHub Releases.
        </div>
      </div>
    </div>
  );
}
