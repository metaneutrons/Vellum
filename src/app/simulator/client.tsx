// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DISPLAY_REGISTRY } from "@/lib/display";

/* ── Constants matching real hardware ─────────────────────────────── */

/* ── Constants ────────────────────────────────────────────────── */

const DISPLAY_MODELS = DISPLAY_REGISTRY;
const FIRMWARE_VER = "sim-1.0.0";

/* ── Types ────────────────────────────────────────────────────────── */

type DeviceState =
  | "off"
  | "booting"
  | "connecting_wifi"
  | "hello"
  | "rendering"
  | "sleeping"
  | "error"
  | "pending";

interface SimConfig {
  serverUrl: string;
  mac: string;
  displayModel: string;
  orientation: "portrait" | "landscape";
  batteryLevel: number;
  batteryVoltage: number;
  powerSource: "usb" | "battery";
  wifiRssi: number;
}

const DEFAULT_CONFIG: SimConfig = {
  serverUrl: "",
  mac: "DEADBEEFCAFE",
  displayModel: "d1001",
  orientation: "portrait",
  batteryLevel: 85,
  batteryVoltage: 3.85,
  powerSource: "battery",
  wifiRssi: -42,
};

/* ── Simulator Component ──────────────────────────────────────────── */

export function SimulatorClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<DeviceState>("off");
  const [token, setToken] = useState<string | null>(null);
  const [sleepSec, setSleepSec] = useState(0);
  const [sleepRemaining, setSleepRemaining] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [config, setConfig] = useState<SimConfig>(DEFAULT_CONFIG);

  // Load persisted config after mount (avoids hydration mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem("vellum-sim-config");
      if (saved) setConfig((c) => ({ ...c, ...JSON.parse(saved) }));
    } catch { /* ignore */ }
  }, []);

  // Persist config changes
  useEffect(() => {
    localStorage.setItem("vellum-sim-config", JSON.stringify(config));
  }, [config]);
  const sleepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const baseUrl = config.serverUrl || (typeof window !== "undefined" ? window.location.origin : "");

  const appendLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString("de-DE", { hour12: false });
    setLog((prev) => [...prev.slice(-200), `[${ts}] ${msg}`]);
  }, []);

  // Reset token when display model changes — forces new hello with updated caps
  const prevModelRef = useRef(config.displayModel);
  useEffect(() => {
    if (config.displayModel !== prevModelRef.current) {
      prevModelRef.current = config.displayModel;
      setToken(null);
      keyPairRef.current = null;
      appendLog(`Display model changed to ${config.displayModel} — token cleared`);
    }
  }, [config.displayModel, appendLog]);

  /* ── Draw pixel buffer onto canvas ──────────────────────────── */

  const drawPixelBuffer = useCallback((buffer: Uint8Array) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dm = DISPLAY_MODELS[config.displayModel] ?? DISPLAY_MODELS.e1001;
    const w = dm.width;
    const h = dm.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const palette = dm.palette;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const palIdx = buffer[i] ?? 1;
      const color = palette[palIdx] ?? palette[1] ?? [255,255,255];
      img.data[i * 4] = color[0];
      img.data[i * 4 + 1] = color[1];
      img.data[i * 4 + 2] = color[2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [config.displayModel]);

  const drawJpeg = useCallback((buffer: Uint8Array) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = new Blob([buffer as unknown as BlobPart], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, []);

  const drawText = useCallback((text: string, sub?: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width || 800;
    const h = canvas.height || 480;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.font = "bold 28px monospace";
    ctx.textAlign = "center";
    ctx.fillText(text, w / 2, h / 2);
    if (sub) {
      ctx.font = "18px monospace";
      ctx.fillStyle = "#888";
      ctx.fillText(sub, w / 2, h / 2 + 36);
    }
  }, []);

  /* ── Firmware cycle ─────────────────────────────────────────── */

  const keyPairRef = useRef<{ privateKey: CryptoKey; publicKeyBase64: string } | null>(null);

  /** Generate or reuse an X25519 keypair for ECDH token decryption */
  const ensureKeyPair = useCallback(async () => {
    if (keyPairRef.current) return keyPairRef.current;
    const kp = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]) as CryptoKeyPair;
    const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
    keyPairRef.current = { privateKey: kp.privateKey, publicKeyBase64 };
    return keyPairRef.current;
  }, []);

  /** Decrypt an encrypted token from the server using ECDH + HKDF + AES-256-GCM */
  const decryptToken = useCallback(async (
    enc: { ciphertext: string; nonce: string; serverPublicKey: string },
    privateKey: CryptoKey
  ): Promise<string> => {
    const serverPubRaw = Uint8Array.from(atob(enc.serverPublicKey), c => c.charCodeAt(0));
    const serverPubKey = await crypto.subtle.importKey(
      "raw", serverPubRaw, "X25519", false, []
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "X25519", public: serverPubKey }, privateKey, 256
    );
    const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
    const aesKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("vellum-token-v1") },
      hkdfKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const ct = Uint8Array.from(atob(enc.ciphertext), c => c.charCodeAt(0));
    const nonce = Uint8Array.from(atob(enc.nonce), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ct);
    return new TextDecoder().decode(decrypted);
  }, []);

  const telemetryHeaders = useCallback((): Record<string, string> => ({
    "X-Battery-Voltage": config.batteryVoltage.toFixed(2),
    "X-Battery-Level": String(config.batteryLevel),
    "X-WiFi-RSSI": String(config.wifiRssi),
    "X-Firmware-Ver": FIRMWARE_VER,
  }), [config]);

  const doHello = useCallback(async (signal: AbortSignal): Promise<string | null> => {
    setState("hello");
    const kp = await ensureKeyPair();
    appendLog("POST /api/v1/ink/hello (with X25519 publicKey + display caps)");
    const dm = DISPLAY_MODELS[config.displayModel] ?? DISPLAY_MODELS.e1001;
    const res = await fetch(`${baseUrl}/api/v1/ink/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...telemetryHeaders() },
      body: JSON.stringify({
        mac: config.mac,
        publicKey: kp.publicKeyBase64,
        display: {
          model: config.displayModel,
          width: dm.width,
          height: dm.height,
          format: dm.format,
          colorMode: dm.colorMode,
          palette: dm.palette,
          orientation: config.orientation,
          orientations: ["portrait", "landscape"],
        },
      }),
      signal,
    });
    const json = await res.json();
    appendLog(`  → ${res.status} ${JSON.stringify(json.data?.status)}`);

    if (json.data?.status === "approved") {
      if (json.data?.encryptedToken) {
        appendLog("  → Decrypting token via ECDH...");
        try {
          const token = await decryptToken(json.data.encryptedToken, kp.privateKey);
          appendLog("  → Token decrypted successfully");
          return token;
        } catch (err) {
          appendLog(`  → Decrypt failed: ${err}`);
          return null;
        }
      }
      if (json.data?.token) {
        appendLog("  → Plaintext token (legacy)");
        return json.data.token as string;
      }
    }
    if (json.data?.status === "pending") {
      setState("pending");
      appendLog("Device is PENDING approval");
      drawText("Pending Approval", `MAC: ${config.mac}`);
      return null;
    }
    return null;
  }, [baseUrl, config.mac, telemetryHeaders, appendLog, drawText, ensureKeyPair, decryptToken]);

  const doRender = useCallback(async (deviceToken: string, signal: AbortSignal): Promise<number> => {
    setState("rendering");
    appendLog(`GET /api/v1/ink/render?mac=${config.mac}`);
    const res = await fetch(
      `${baseUrl}/api/v1/ink/render?mac=${encodeURIComponent(config.mac)}`,
      {
        headers: { "X-Device-Token": deviceToken, ...telemetryHeaders() },
        signal,
      }
    );
    const sleep = parseInt(res.headers.get("X-Sleep-Duration") ?? "900", 10);
    appendLog(`  → ${res.status}, sleep=${sleep}s`);

    if (res.status === 200) {
      const contentType = res.headers.get("Content-Type") ?? "";
      const buf = new Uint8Array(await res.arrayBuffer());
      appendLog(`  → ${buf.length} bytes (${contentType})`);
      if (contentType.includes("jpeg") || contentType.includes("jpg")) {
        drawJpeg(buf);
      } else {
        drawPixelBuffer(buf);
      }
    } else if (res.status === 204) {
      appendLog("  → 204 No Content — device not configured");
      drawText("Not Configured", "Assign content in the Vellum Console");
    } else if (res.status === 401) {
      appendLog("  → 401 Unauthorized — clearing token");
      drawText("Unauthorized", "Token expired — re-authenticating...");
      setToken(null);
      return 30;
    } else if (res.status === 404) {
      appendLog("  → 404 Not Found");
      drawText("Device Not Found", "Register this device in the Vellum Console");
    } else {
      const body = await res.json().catch(() => null);
      const msg = body?.error ?? `HTTP ${res.status}`;
      appendLog(`  → error: ${msg}`);
      drawText("Error", msg);
    }
    return sleep;
  }, [baseUrl, config.mac, telemetryHeaders, appendLog, drawPixelBuffer, drawJpeg, drawText]);

  const runCycle = useCallback(async () => {
    if (sleepTimerRef.current) {
      clearInterval(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // Boot
      setState("booting");
      appendLog(`===== Vellum Simulator v${FIRMWARE_VER} =====`);
      drawText("Booting...");
      await new Promise((r) => setTimeout(r, 400));

      // Wi-Fi
      setState("connecting_wifi");
      appendLog("Connecting to Wi-Fi...");
      drawText("Connecting to Wi-Fi...");
      await new Promise((r) => setTimeout(r, 600));
      appendLog("Wi-Fi connected");

      // Hello (if no token)
      let currentToken = token;
      if (!currentToken) {
        currentToken = await doHello(abort.signal);
        if (!currentToken) {
          // pending — sleep and retry
          setSleepSec(30);
          setSleepRemaining(30);
          setState("sleeping");
          return;
        }
        setToken(currentToken);
        appendLog("Token acquired");
      }

      // Render
      const sleep = await doRender(currentToken, abort.signal);

      // Sleep
      setState("sleeping");
      setSleepSec(sleep);
      setSleepRemaining(sleep);
      appendLog(`Entering deep sleep for ${sleep}s`);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState("error");
      appendLog(`ERROR: ${err}`);
      drawText("Error", String(err));
      setSleepSec(60);
      setSleepRemaining(60);
    }
  }, [token, doHello, doRender, appendLog, drawText]);

  /* ── Sleep countdown ────────────────────────────────────────── */

  useEffect(() => {
    if (state !== "sleeping" || sleepRemaining <= 0) return;
    sleepTimerRef.current = setInterval(() => {
      setSleepRemaining((prev) => {
        if (prev <= 1) {
          if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
          sleepTimerRef.current = null;
          runCycle();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
    };
  }, [state, sleepRemaining, runCycle]);

  /* ── Button handlers ────────────────────────────────────────── */

  const handlePowerOn = () => {
    setToken(null);
    runCycle();
  };

  const handleRefresh = () => {
    appendLog("Button: Refresh pressed");
    runCycle();
  };

  const handleReport = async () => {
    if (!token) { appendLog("No token — cannot report"); return; }
    appendLog("Button: Report pressed");
    try {
      const res = await fetch(`${baseUrl}/api/v1/ink/report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Token": token,
          ...telemetryHeaders(),
        },
        body: JSON.stringify({ mac: config.mac, issue: "Room issue reported via simulator button" }),
      });
      appendLog(`  → report: ${res.status}`);
    } catch (err) {
      appendLog(`  → report error: ${err}`);
    }
  };

  const handlePowerOff = () => {
    abortRef.current?.abort();
    if (sleepTimerRef.current) clearInterval(sleepTimerRef.current);
    setState("off");
    setSleepRemaining(0);
    appendLog("Power OFF");
    drawText("", "");
    const canvas = canvasRef.current;
    if (canvas) {
      const dm = DISPLAY_MODELS[config.displayModel] ?? DISPLAY_MODELS.e1001;
      canvas.width = dm.width;
      canvas.height = dm.height;
      const ctx = canvas.getContext("2d");
      if (ctx) { ctx.fillStyle = "#e8e4d8"; ctx.fillRect(0, 0, dm.width, dm.height); }
    }
  };

  /* ── Init canvas ────────────────────────────────────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#e8e4d8";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  /* ── Render ─────────────────────────────────────────────────── */

  const stateColor: Record<DeviceState, string> = {
    off: "#666", booting: "#f59e0b", connecting_wifi: "#3b82f6",
    hello: "#8b5cf6", rendering: "#10b981", sleeping: "#6366f1",
    error: "#ef4444", pending: "#f97316",
  };

  return (
    <div style={{ background: "#1a1a2e", minHeight: "100vh", padding: 24, fontFamily: "system-ui, sans-serif", color: "#e0e0e0" }}>
      <h1 style={{ margin: "0 0 16px", fontSize: 20, color: "#888" }}>
        Vellum Device Simulator
        <span style={{ fontSize: 12, marginLeft: 12, color: "#555" }}>DEV ONLY</span>
      </h1>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        {/* ── Device ──────────────────────────────────────────── */}
        <div style={{ background: "#2d2d3f", borderRadius: 16, padding: 20, display: "flex", flexDirection: "column", alignItems: "center" }}>
          {/* Status bar */}
          <div style={{ display: "flex", gap: 12, marginBottom: 12, fontSize: 13, alignItems: "center", width: "100%" }}>
            <span style={{ background: stateColor[state], borderRadius: 4, padding: "2px 8px", color: "#fff", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
              {state.replace("_", " ")}
            </span>
            {state === "sleeping" && <span style={{ color: "#6366f1" }}>⏱ {sleepRemaining}s / {sleepSec}s</span>}
            <span style={{ marginLeft: "auto", color: "#888", fontSize: 11 }}>
              🔋 {config.batteryLevel}% &nbsp; 📶 {config.wifiRssi}dBm
            </span>
          </div>

          {/* Device frame */}
          <div style={{
            background: "#1a1a1a", borderRadius: 12, padding: 12,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
            position: "relative",
          }}>
            {/* Buttons — left side */}
            <div style={{ position: "absolute", left: -44, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 12 }}>
              <button onClick={handleRefresh} disabled={state === "off"} title="Refresh (Button 1)"
                style={{ ...btnStyle, background: state === "off" ? "#333" : "#4ade80" }}>↻</button>
              <button onClick={handleReport} disabled={state === "off" || !token} title="Report Issue (Button 2)"
                style={{ ...btnStyle, background: state === "off" ? "#333" : "#fbbf24" }}>⚠</button>
              <button onClick={state === "off" ? handlePowerOn : handlePowerOff} title={state === "off" ? "Power On" : "Power Off"}
                style={{ ...btnStyle, background: state === "off" ? "#22c55e" : "#ef4444" }}>⏻</button>
            </div>

            {/* LEDs */}
            <div style={{ position: "absolute", right: -32, top: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              <div title="Power LED (red=charging)" style={{ width: 8, height: 8, borderRadius: "50%", background: config.powerSource === "usb" ? "#ef4444" : "#333" }} />
              <div title="Status LED (green)" style={{ width: 8, height: 8, borderRadius: "50%", background: state !== "off" ? "#22c55e" : "#333" }} />
            </div>

            {/* Canvas */}
            {(() => {
              const dm = DISPLAY_MODELS[config.displayModel] ?? DISPLAY_MODELS.e1001;
              const isLandscape = config.orientation === "landscape";
              const cw = isLandscape ? Math.max(dm.width, dm.height) : Math.min(dm.width, dm.height);
              const ch = isLandscape ? Math.min(dm.width, dm.height) : Math.max(dm.width, dm.height);
              const maxDim = 500;
              const scale = Math.min(maxDim / cw, maxDim / ch);
              return (
                <canvas
                  ref={canvasRef}
                  width={cw}
                  height={ch}
                  style={{
                    display: "block",
                    width: Math.round(cw * scale),
                    height: Math.round(ch * scale),
                    borderRadius: 4,
                    imageRendering: "pixelated",
                    filter: state === "off" ? "brightness(0.3)" : "none",
                  }}
                />
              );
            })()}
          </div>

          <div style={{ fontSize: 11, color: "#555", marginTop: 8 }}>
            {(() => {
              const dm = DISPLAY_MODELS[config.displayModel] ?? DISPLAY_MODELS.e1001;
              const isLandscape = config.orientation === "landscape";
              const w = isLandscape ? Math.max(dm.width, dm.height) : Math.min(dm.width, dm.height);
              const h = isLandscape ? Math.min(dm.width, dm.height) : Math.max(dm.width, dm.height);
              return `${w} × ${h} · ${dm.name} · ${config.orientation}`;
            })()}
          </div>
        </div>

        {/* ── Controls + Log ──────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 320, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Config panel */}
          <div style={{ background: "#2d2d3f", borderRadius: 8, padding: 16 }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#888" }}>Device Configuration</h3>
            <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "8px 12px", fontSize: 13 }}>
              <label>MAC Address</label>
              <input value={config.mac} onChange={(e) => setConfig((c) => ({ ...c, mac: e.target.value }))}
                style={inputStyle} />
              <label>Server URL</label>
              <input value={config.serverUrl} placeholder="(auto — current origin)" onChange={(e) => setConfig((c) => ({ ...c, serverUrl: e.target.value }))}
                style={inputStyle} />
              <label>Battery %</label>
              <input type="range" min={0} max={100} value={config.batteryLevel}
                onChange={(e) => setConfig((c) => ({ ...c, batteryLevel: +e.target.value, batteryVoltage: 3.0 + (+e.target.value / 100) * 1.2 }))} />
              <label>Power</label>
              <select value={config.powerSource} onChange={(e) => setConfig((c) => ({ ...c, powerSource: e.target.value as "usb" | "battery" }))}
                style={inputStyle}>
                <option value="battery">Battery</option>
                <option value="usb">USB</option>
              </select>
              <label>Display</label>
              <select value={config.displayModel} onChange={(e) => setConfig((c) => ({ ...c, displayModel: e.target.value }))}
                style={inputStyle}>
                {Object.entries(DISPLAY_MODELS).map(([id, m]) => (
                  <option key={id} value={id}>{m.name}</option>
                ))}
              </select>
              <label>Orientation</label>
              <select value={config.orientation} onChange={(e) => setConfig((c) => ({ ...c, orientation: e.target.value as "portrait" | "landscape" }))}
                style={inputStyle}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </div>
          </div>

          {/* Log */}
          <div style={{ background: "#0d0d1a", borderRadius: 8, padding: 12, flex: 1, minHeight: 300 }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 14, color: "#888" }}>Serial Monitor</h3>
            <pre style={{
              margin: 0, fontSize: 11, lineHeight: 1.6, color: "#4ade80",
              fontFamily: "ui-monospace, monospace", overflow: "auto", maxHeight: 400,
              whiteSpace: "pre-wrap", wordBreak: "break-all",
            }}>
              {log.join("\n") || "Device is off. Press ⏻ to boot."}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Shared styles ────────────────────────────────────────────────── */

const btnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: "50%", border: "2px solid #444",
  color: "#fff", fontWeight: "bold", fontSize: 16, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
  lineHeight: 1,
};

const inputStyle: React.CSSProperties = {
  background: "#1a1a2e", border: "1px solid #444", borderRadius: 4,
  padding: "4px 8px", color: "#e0e0e0", fontSize: 13,
};
