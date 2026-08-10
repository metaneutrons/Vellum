// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  encodeWifiSettings,
  encodeScanWifi,
  encodeGetState,
  decodeScanNetwork,
  encodeFrame,
  ImprovParser,
  decodeRpcResult,
  wifiSettingsPayloadLength,
  MAX_WIFI_SETTINGS_PAYLOAD,
  IMPROV_HEADER,
  IMPROV_VERSION,
  ImprovType,
  ImprovCmd,
  ImprovState,
  ImprovError,
  improvErrorMessage,
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
  ntp?: string;
  time?: string;
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
  let ntp: string | undefined;
  let time: string | undefined;
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
        pos += 1 + tokLen;
        if (pos < p.length) {
          const ntpLen = p[pos];
          if (ntpLen > 0 && pos + 1 + ntpLen <= p.length) {
            ntp = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + ntpLen)));
          }
          pos += 1 + ntpLen;
          if (pos < p.length) {
            const timeLen = p[pos];
            if (timeLen > 0 && pos + 1 + timeLen === p.length) {
              time = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + timeLen)));
            }
          }
        }
      }
    }
  }
  return { ok: true, ssid, pass, url, token, ntp, time };
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

  it("carries the administrator NTP server as the fifth string", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", "https://v.io", "tok123", "ntp.internal.example"),
    );
    expect(parsed.url).toBe("https://v.io");
    expect(parsed.token).toBe("tok123");
    expect(parsed.ntp).toBe("ntp.internal.example");
  });

  it("uses positional empty URL and token strings for an NTP-only override", () => {
    const parsed = firmwareParse(encodeWifiSettings("Net", "pw", undefined, undefined, "192.168.16.1"));
    expect(parsed.url).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.ntp).toBe("192.168.16.1");
  });

  it("carries browser UTC as the sixth string", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", "https://v.io", "tok123", "ntp.internal", 1_786_291_200),
    );
    expect(parsed.ntp).toBe("ntp.internal");
    expect(parsed.time).toBe("1786291200");
  });

  it("uses all positional placeholders for a timestamp-only profile", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", undefined, undefined, undefined, 1_786_291_200),
    );
    expect(parsed.url).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.ntp).toBeUndefined();
    expect(parsed.time).toBe("1786291200");
  });

  it("rejects timestamps outside the RTC-supported range", () => {
    expect(() => encodeWifiSettings("Net", "pw", undefined, undefined, undefined, Number.NaN)).toThrow(
      /UTC timestamp/,
    );
    expect(() => encodeWifiSettings("Net", "pw", undefined, undefined, undefined, 1_700_000_000)).toThrow(
      /UTC timestamp/,
    );
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

describe("Improv harmless readiness probe", () => {
  it("encodes GET_STATE as an RPC command with no payload", () => {
    const frame = encodeGetState();
    expect(frame[7]).toBe(ImprovType.RPC_COMMAND);
    expect(Array.from(frame.slice(9, 11))).toEqual([ImprovCmd.GET_STATE, 0]);
  });
});

describe("WIFI_SETTINGS payload-size guard", () => {
  // The payload becomes a single-byte cmd_len, so it must stay ≤253 or the
  // length wraps and the firmware silently rejects (or misreads) the frame.
  it("predicts the exact encoded payload length (matches the real frame)", () => {
    const cases: [string, string, string?, string?, string?, number?][] = [
      ["MyNet", "s3cret!!", "https://vellum.example.com", undefined, undefined],
      ["Net", "pw", "https://v.io", "a".repeat(64), undefined],
      ["Net", "pw", undefined, "tok123", undefined],
      ["Café-WLAN", "", "http://x", undefined, undefined],
      ["Net", "pw", undefined, undefined, "ntp.internal"],
      ["Net", "pw", undefined, undefined, undefined, 1_786_291_200],
      ["Net", "pw", undefined, undefined, undefined],
    ];
    for (const [ssid, pass, url, tok, ntp, time] of cases) {
      const frame = encodeWifiSettings(ssid, pass, url, tok, ntp, time);
      // frame[8] is data_len = cmd_len + 2 (cmd byte + cmd_len byte); the payload
      // is cmd_len, so predicted length === data_len - 2.
      expect(wifiSettingsPayloadLength(ssid, pass, url, tok, ntp, time)).toBe(frame[8] - 2);
    }
  });

  it("accepts a profile exactly at the 253-byte limit", () => {
    // ssid(1+5) + pass(1+1) + url(1+len) === 253  →  url len = 244
    const url = "u".repeat(MAX_WIFI_SETTINGS_PAYLOAD - (1 + 5) - (1 + 1) - 1);
    expect(wifiSettingsPayloadLength("hello", "p", url)).toBe(MAX_WIFI_SETTINGS_PAYLOAD);
    expect(() => encodeWifiSettings("hello", "p", url)).not.toThrow();
  });

  it("throws instead of emitting a corrupt over-253-byte frame", () => {
    // 250-byte URL is a valid single string (≤255) but overflows the total payload.
    const url = "u".repeat(250);
    expect(wifiSettingsPayloadLength("hello", "p", url)).toBeGreaterThan(MAX_WIFI_SETTINGS_PAYLOAD);
    expect(() => encodeWifiSettings("hello", "p", url)).toThrow(/too large/);
  });
});

describe("ImprovParser (device → browser)", () => {
  it("explains a production firmware rejection without implying settings changed", () => {
    expect(improvErrorMessage(ImprovError.INSECURE_URL)).toBe(
      "This production firmware requires an https:// server URL. No settings were changed.",
    );
  });

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
