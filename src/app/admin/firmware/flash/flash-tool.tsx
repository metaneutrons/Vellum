"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";

export function FlashTool() {
  const [model, setModel] = useState("e1002");
  const [channel, setChannel] = useState("stable");
  const [loaded, setLoaded] = useState(false);

  const manifestUrl = `/api/v1/admin/flash-manifest?model=${model}&channel=${channel}`;

  useEffect(() => {
    if (loaded) return;
    const existing = document.querySelector('script[src="/install-button.js"]');
    if (existing) { setLoaded(true); return; }
    const script = document.createElement("script");
    script.src = "/install-button.js";
    script.type = "module";
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, [loaded]);

  return (
    <div>
      <Link href="/admin/firmware" className="text-sm text-blue-500 hover:underline mb-4 inline-block">← Back to Firmware</Link>
      <PageHeader title="Flash Firmware" description="Flash firmware directly from the browser via USB" />

      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow p-6 max-w-lg">
        <label className="block text-sm font-medium mb-1">Display Model</label>
        <select className="w-full border rounded px-3 py-2 mb-4 text-sm" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Display model">
          <option value="e1001">E1001 (7.5&quot; B&amp;W)</option>
          <option value="e1002">E1002 (7.3&quot; Color)</option>
          <option value="e1003">E1003 (10.3&quot; Mono)</option>
        </select>

        <label className="block text-sm font-medium mb-1">Channel</label>
        <select className="w-full border rounded px-3 py-2 mb-6 text-sm" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Firmware channel">
          <option value="stable">Stable</option>
          <option value="beta">Beta</option>
        </select>

        {/* ESP Web Tools install button — provides full flash UX with progress */}
        <div key={`${model}-${channel}`}>
          {loaded ? (
            <div
              dangerouslySetInnerHTML={{
                __html: `<esp-web-install-button manifest="${manifestUrl}">
                  <button slot="activate" style="width:100%;padding:12px 20px;background:#2563eb;color:white;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer">⚡ Connect &amp; Flash</button>
                  <span slot="unsupported"><div style="padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#b45309">⚠ Web Serial is not supported in this browser. Please use Chrome or Edge.</div></span>
                  <span slot="not-allowed"><div style="padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#dc2626">⚠ Serial port access was denied. Check your browser permissions.</div></span>
                </esp-web-install-button>`,
              }}
            />
          ) : (
            <div className="w-full py-3 bg-gray-200 rounded-lg text-center text-sm text-gray-500">
              Loading flash tools…
            </div>
          )}
        </div>

        <div className="mt-6 space-y-2 text-xs text-gray-500">
          <p className="font-medium text-gray-700">Instructions:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Connect the device via USB-C cable</li>
            <li>Turn on the device (power switch on back)</li>
            <li>Click &quot;Connect &amp; Flash&quot; and select the serial port</li>
            <li>Wait for the flash to complete — do not disconnect</li>
          </ol>
        </div>

        <div className="mt-4 p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg text-xs text-gray-500">
          <p>Requires <strong>Chrome 89+</strong> or <strong>Edge 89+</strong> with Web Serial API support.</p>
          <p className="mt-1">The firmware binary is downloaded from GitHub Releases via a local proxy.</p>
        </div>
      </div>
    </div>
  );
}
