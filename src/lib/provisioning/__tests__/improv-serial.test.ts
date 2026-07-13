// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  encodeWifiSettings,
  encodeScanWifi,
  decodeScanNetwork,
  encodeFrame,
  ImprovParser,
  decodeRpcResult,
  IMPROV_HEADER,
  IMPROV_VERSION,
  ImprovType,
  ImprovCmd,
  ImprovState,
} from "../improv-serial";

/**
 * Mirror of firmware improv_try_parse + improv_handle_rpc + improv_handle_wifi_settings
 * (vellum_serial.c). Proves the browser client emits bytes the firmware parses.
 */
function firmwareParse(frame: Uint8Array): {
  ok: boolean;
  ssid?: string;
  pass?: string;
  url?: string;
  token?: string;
} {
  const b = Array.from(frame);
  if (b.length < 10) return { ok: false };
  for (let i = 0; i < 6; i++) if (b[i] !== IMPROV_HEADER[i]) return { ok: false };
  if (b[6] !== IMPROV_VERSION) return { ok: false };
  const dataLen = b[8];
  if (b.length < 10 + dataLen) return { ok: false };
  let cs = 0;
  for (let i = 0; i < 9 + dataLen; i++) cs = (cs + b[i]) & 0xff;
  if (cs !== b[9 + dataLen]) return { ok: false };
  if (b[7] !== ImprovType.RPC_COMMAND) return { ok: false };

  // improv_handle_rpc: data = b[9..], len = dataLen
  const data = b.slice(9, 9 + dataLen);
  const cmd = data[0];
  const cmdLen = data[1];
  if (2 + cmdLen > data.length) return { ok: false };
  if (cmd !== ImprovCmd.WIFI_SETTINGS) return { ok: true };

  // improv_handle_wifi_settings: p = data[2..], len = cmdLen
  const p = data.slice(2, 2 + cmdLen);
  const dec = new TextDecoder();
  const ssidLen = p[0];
  const ssid = dec.decode(Uint8Array.from(p.slice(1, 1 + ssidLen)));
  const passLen = p[1 + ssidLen];
  const pass = dec.decode(Uint8Array.from(p.slice(2 + ssidLen, 2 + ssidLen + passLen)));
  let url: string | undefined;
  let token: string | undefined;
  let pos = 2 + ssidLen + passLen;
  if (pos < p.length) {
    const urlLen = p[pos];
    if (pos + 1 + urlLen <= p.length) {
      if (urlLen > 0) url = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + urlLen)));
      pos += 1 + urlLen; // advance past URL (even if empty)
      if (pos < p.length) {
        const tokLen = p[pos];
        if (tokLen > 0 && pos + 1 + tokLen <= p.length) {
          token = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + tokLen)));
        }
      }
    }
  }
  return { ok: true, ssid, pass, url, token };
}

describe("Improv WIFI_SETTINGS encoding", () => {
  it("emits a well-formed frame the firmware parser accepts (ssid+pass+url)", () => {
    const frame = encodeWifiSettings("MyNet", "s3cret!!", "https://vellum.example.com");
    // structural: header, version, type
    expect(Array.from(frame.slice(0, 6))).toEqual([...IMPROV_HEADER]);
    expect(frame[6]).toBe(IMPROV_VERSION);
    expect(frame[7]).toBe(ImprovType.RPC_COMMAND);

    const parsed = firmwareParse(frame);
    expect(parsed.ok).toBe(true);
    expect(parsed.ssid).toBe("MyNet");
    expect(parsed.pass).toBe("s3cret!!");
    expect(parsed.url).toBe("https://vellum.example.com");
  });

  it("carries the zero-touch device token as the 4th string", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", "https://v.io", "a".repeat(64)),
    );
    expect(parsed.url).toBe("https://v.io");
    expect(parsed.token).toBe("a".repeat(64));
  });

  it("puts the token 4th even without a server URL (empty URL placeholder)", () => {
    const parsed = firmwareParse(encodeWifiSettings("Net", "pw", undefined, "tok123"));
    expect(parsed.url).toBeUndefined();
    expect(parsed.token).toBe("tok123");
  });

  it("omits the URL string when serverUrl is absent (2-string form)", () => {
    const frame = encodeWifiSettings("Net", "pw");
    const parsed = firmwareParse(frame);
    expect(parsed.ssid).toBe("Net");
    expect(parsed.pass).toBe("pw");
    expect(parsed.url).toBeUndefined();
  });

  it("handles open networks (empty password) and utf-8 ssids", () => {
    const parsed = firmwareParse(encodeWifiSettings("Café-WLAN", "", "http://x"));
    expect(parsed.ssid).toBe("Café-WLAN");
    expect(parsed.pass).toBe("");
    expect(parsed.url).toBe("http://x");
  });

  it("computes an 8-bit sum checksum over the first 9+len bytes", () => {
    const frame = encodeWifiSettings("a", "b", "c");
    const len = frame[8];
    let cs = 0;
    for (let i = 0; i < 9 + len; i++) cs = (cs + frame[i]) & 0xff;
    expect(frame[9 + len]).toBe(cs);
    expect(frame.length).toBe(10 + len);
  });
});

describe("ImprovParser (device → browser)", () => {
  it("extracts a state frame surrounded by console text noise", () => {
    const stateFrame = encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONED]);
    const noise = new TextEncoder().encode("vellum> Improv: WiFi connected\r\n");
    const stream = new Uint8Array([...noise, ...stateFrame, ...new TextEncoder().encode("x")]);

    const frames = new ImprovParser().push(stream);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(ImprovType.CURRENT_STATE);
    expect(frames[0].payload[0]).toBe(ImprovState.PROVISIONED);
  });

  it("reassembles a frame split across chunk boundaries", () => {
    const frame = encodeFrame(ImprovType.ERROR_STATE, [0x03]);
    const p = new ImprovParser();
    expect(p.push(frame.slice(0, 4))).toHaveLength(0); // partial
    expect(p.push(frame.slice(4, 8))).toHaveLength(0); // still partial
    const out = p.push(frame.slice(8));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(ImprovType.ERROR_STATE);
    expect(out[0].payload[0]).toBe(0x03);
  });

  it("rejects a frame with a bad checksum and resyncs to the next", () => {
    const good = encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONING]);
    const bad = Uint8Array.from(good);
    bad[bad.length - 1] ^= 0xff; // corrupt checksum
    const out = new ImprovParser().push(new Uint8Array([...bad, ...good]));
    // the corrupted copy is dropped; the clean one still parses
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[out.length - 1].payload[0]).toBe(ImprovState.PROVISIONING);
  });

  it("encodes a SCAN_WIFI command with an empty payload", () => {
    const frame = encodeScanWifi();
    expect(frame[7]).toBe(ImprovType.RPC_COMMAND);
    // payload = [cmd=SCAN_WIFI, cmdLen=0]
    expect(frame[9]).toBe(ImprovCmd.SCAN_WIFI);
    expect(frame[10]).toBe(0);
  });

  it("decodes SCAN_WIFI networks and treats the empty result as a terminator", () => {
    expect(decodeScanNetwork(["OfficeWiFi", "-52", "YES"])).toEqual({
      ssid: "OfficeWiFi",
      rssi: -52,
      secured: true,
    });
    expect(decodeScanNetwork(["Guest", "-70", "NO"])?.secured).toBe(false);
    expect(decodeScanNetwork([])).toBeNull(); // list terminator
  });

  it("decodes an RPC_RESULT into its length-prefixed strings", () => {
    // device-style RPC_RESULT payload: [cmd, dataLen, s0len, s0, s1len, s1]
    const dec = (s: string) => Array.from(new TextEncoder().encode(s));
    const s0 = dec("http://192.168.1.50/");
    const inner = [s0.length, ...s0];
    const payload = [ImprovCmd.WIFI_SETTINGS, inner.length, ...inner];
    const frame = encodeFrame(ImprovType.RPC_RESULT, payload);
    const [f] = new ImprovParser().push(frame);
    const { cmd, strings } = decodeRpcResult(f.payload);
    expect(cmd).toBe(ImprovCmd.WIFI_SETTINGS);
    expect(strings[0]).toBe("http://192.168.1.50/");
  });
});
