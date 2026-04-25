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
    const script = document.createElement("script");
    script.src = "/install-button.js";
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
          <option value="stable">stable</option>
          <option value="beta">beta</option>
        </select>

        <div className="mt-2" key={model + channel}>
          <div
            dangerouslySetInnerHTML={{
              __html: `<esp-web-install-button manifest="${manifestUrl}"><button slot="activate" style="width:100%;padding:10px 20px;background:#3b82f6;color:white;border:none;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer">Connect &amp; Flash</button><span slot="unsupported"><div style="padding:12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:13px;color:#f59e0b">⚠ Web Serial not supported. Use Chrome or Edge.</div></span></esp-web-install-button>`,
            }}
          />
        </div>

        <div className="mt-6 text-xs text-gray-500 space-y-1">
          <p>1. Connect the device via USB-C cable</p>
          <p>2. Turn on the device (power switch on back)</p>
          <p>3. Click &quot;Connect &amp; Flash&quot; and select the serial port</p>
          <p>4. Wait for the flash to complete — do not disconnect</p>
        </div>
      </div>
    </div>
  );
}
