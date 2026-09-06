// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { afterEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  encodeAuthorizeProvisioning,
  encodeGetProvisioningSecurity,
  encodeWifiSettings,
  encodeScanWifi,
  encodeGetState,
  decodeScanNetwork,
  encodeFrame,
  ImprovParser,
  decodeRpcResult,
  wifiSettingsPayloadLength,
  wifiSettingsPayload,
  MAX_WIFI_SETTINGS_PAYLOAD,
  MAX_PROVISIONING_UNIX_TIME,
  IMPROV_HEADER,
  IMPROV_VERSION,
  ImprovType,
  ImprovCmd,
  ImprovState,
  ImprovError,
  SerialProvisioningSession,
  improvErrorMessage,
  scanNetworksOverSerial,
  provisionOverSerial,
  describeSerialError,
  type UsbProvisioningAuthorizationRequest,
} from "../improv-serial";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  const dataLen = b[8]!;
  if (b.length < 10 + dataLen) return { ok: false };
  let cs = 0;
  for (let i = 0; i < 9 + dataLen; i++) cs = (cs + b[i]!) & 0xff;
  if (cs !== b[9 + dataLen]!) return { ok: false };
  if (b[7] !== ImprovType.RPC_COMMAND) return { ok: false };

  // improv_handle_rpc: data = b[9..], len = dataLen
  const data = b.slice(9, 9 + dataLen);
  const cmd = data[0];
  const cmdLen = data[1]!;
  if (2 + cmdLen > data.length) return { ok: false };
  if (cmd !== ImprovCmd.WIFI_SETTINGS) return { ok: true };

  // improv_handle_wifi_settings: p = data[2..], len = cmdLen
  const p = data.slice(2, 2 + cmdLen);
  const dec = new TextDecoder();
  const ssidLen = p[0]!;
  const ssid = dec.decode(Uint8Array.from(p.slice(1, 1 + ssidLen)));
  const passLen = p[1 + ssidLen]!;
  const pass = dec.decode(Uint8Array.from(p.slice(2 + ssidLen, 2 + ssidLen + passLen)));
  let url: string | undefined;
  let token: string | undefined;
  let ntp: string | undefined;
  let time: string | undefined;
  let pos = 2 + ssidLen + passLen;
  if (pos < p.length) {
    const urlLen = p[pos]!;
    if (pos + 1 + urlLen <= p.length) {
      if (urlLen > 0) url = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + urlLen)));
      pos += 1 + urlLen; // advance past URL (even if empty)
      if (pos < p.length) {
        const tokLen = p[pos]!;
        if (tokLen > 0 && pos + 1 + tokLen <= p.length) {
          token = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + tokLen)));
        }
        pos += 1 + tokLen;
        if (pos < p.length) {
          const ntpLen = p[pos]!;
          if (ntpLen > 0 && pos + 1 + ntpLen <= p.length) {
            ntp = dec.decode(Uint8Array.from(p.slice(pos + 1, pos + 1 + ntpLen)));
          }
          pos += 1 + ntpLen;
          if (pos < p.length) {
            const timeLen = p[pos]!;
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
    const parsed = firmwareParse(encodeWifiSettings("Net", "pw", "https://v.io", "a".repeat(64)));
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
      encodeWifiSettings("Net", "pw", "https://v.io", "tok123", "ntp.internal.example")
    );
    expect(parsed.url).toBe("https://v.io");
    expect(parsed.token).toBe("tok123");
    expect(parsed.ntp).toBe("ntp.internal.example");
  });

  it("uses positional empty URL and token strings for an NTP-only override", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", undefined, undefined, "192.168.16.1")
    );
    expect(parsed.url).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.ntp).toBe("192.168.16.1");
  });

  it("carries browser UTC as the sixth string", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", "https://v.io", "tok123", "ntp.internal", 1_786_291_200)
    );
    expect(parsed.ntp).toBe("ntp.internal");
    expect(parsed.time).toBe("1786291200");
  });

  it("uses all positional placeholders for a timestamp-only profile", () => {
    const parsed = firmwareParse(
      encodeWifiSettings("Net", "pw", undefined, undefined, undefined, 1_786_291_200)
    );
    expect(parsed.url).toBeUndefined();
    expect(parsed.token).toBeUndefined();
    expect(parsed.ntp).toBeUndefined();
    expect(parsed.time).toBe("1786291200");
  });

  it("rejects timestamps outside the RTC-supported range", () => {
    expect(() =>
      encodeWifiSettings("Net", "pw", undefined, undefined, undefined, Number.NaN)
    ).toThrow(/UTC timestamp/);
    expect(() =>
      encodeWifiSettings("Net", "pw", undefined, undefined, undefined, 1_700_000_000)
    ).toThrow(/UTC timestamp/);
    expect(() =>
      encodeWifiSettings(
        "Net",
        "pw",
        undefined,
        undefined,
        undefined,
        MAX_PROVISIONING_UNIX_TIME + 1
      )
    ).toThrow(/UTC timestamp/);
  });

  it("accepts the longest valid timestamp for payload-size reservation", () => {
    expect(() =>
      wifiSettingsPayloadLength(
        "Net",
        "pw",
        "https://vellum.example",
        undefined,
        "",
        MAX_PROVISIONING_UNIX_TIME
      )
    ).not.toThrow();
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
    const len = frame[8]!;
    let cs = 0;
    for (let i = 0; i < 9 + len; i++) cs = (cs + frame[i]!) & 0xff;
    expect(frame[9 + len]!).toBe(cs);
    expect(frame.length).toBe(10 + len);
  });
});

describe("Improv harmless readiness probe", () => {
  it("encodes GET_STATE as an RPC command with no payload", () => {
    const frame = encodeGetState();
    expect(frame[7]).toBe(ImprovType.RPC_COMMAND);
    expect(Array.from(frame.slice(9, 11))).toEqual([ImprovCmd.GET_STATE, 0]);
  });

  it("encodes the Vellum security challenge and authorization RPCs", () => {
    expect(Array.from(encodeGetProvisioningSecurity().slice(9, 11))).toEqual([
      ImprovCmd.GET_PROVISIONING_SECURITY,
      0,
    ]);
    const digest = Uint8Array.from({ length: 32 }, (_, index) => index);
    const auth = encodeAuthorizeProvisioning(digest, "aa".repeat(32));
    expect(auth[9]).toBe(ImprovCmd.AUTHORIZE_PROVISIONING);
    expect(auth[10]).toBe(64);
    expect(Array.from(auth.slice(11, 43))).toEqual(Array.from(digest));
    expect(Array.from(auth.slice(43, 75))).toEqual(Array(32).fill(0xaa));
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
      expect(wifiSettingsPayloadLength(ssid, pass, url, tok, ntp, time)).toBe(frame[8]! - 2);
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
      "This production firmware requires an https:// server URL. No settings were changed."
    );
  });

  /* A device can send ERROR_STATE with no payload at all. Reading the code that
   * is not there used to reach `undefined.toString(16)`, so the operator got a
   * TypeError instead of the error the display was reporting. */
  it("names an error frame that carries no code", () => {
    const [frame] = new ImprovParser().push(encodeFrame(ImprovType.ERROR_STATE, []));
    expect(frame!.payload).toHaveLength(0);
    expect(improvErrorMessage(frame!.payload[0])).toBe("Display reported an error without a code.");
  });

  it("decodes an RPC result whose payload is too short to name a command", () => {
    expect(decodeRpcResult(new Uint8Array([]))).toEqual({ cmd: undefined, strings: [] });
    expect(decodeRpcResult(new Uint8Array([ImprovCmd.SCAN_WIFI]))).toEqual({
      cmd: ImprovCmd.SCAN_WIFI,
      strings: [],
    });
  });

  it("extracts a state frame surrounded by console text noise", () => {
    const stateFrame = encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONED]);
    const noise = new TextEncoder().encode("vellum> Improv: WiFi connected\r\n");
    const stream = new Uint8Array([...noise, ...stateFrame, ...new TextEncoder().encode("x")]);

    const frames = new ImprovParser().push(stream);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe(ImprovType.CURRENT_STATE);
    expect(frames[0]!.payload[0]).toBe(ImprovState.PROVISIONED);
  });

  it("reassembles a frame split across chunk boundaries", () => {
    const frame = encodeFrame(ImprovType.ERROR_STATE, [0x03]);
    const p = new ImprovParser();
    expect(p.push(frame.slice(0, 4))).toHaveLength(0); // partial
    expect(p.push(frame.slice(4, 8))).toHaveLength(0); // still partial
    const out = p.push(frame.slice(8));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe(ImprovType.ERROR_STATE);
    expect(out[0]!.payload[0]).toBe(0x03);
  });

  it("rejects a frame with a bad checksum and resyncs to the next", () => {
    const good = encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONING]);
    const bad = Uint8Array.from(good);
    bad[bad.length - 1]! ^= 0xff; // corrupt checksum
    const out = new ImprovParser().push(new Uint8Array([...bad, ...good]));
    // the corrupted copy is dropped; the clean one still parses
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[out.length - 1]!.payload[0]).toBe(ImprovState.PROVISIONING);
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
    const f = new ImprovParser().push(frame)[0]!;
    const { cmd, strings } = decodeRpcResult(f.payload);
    expect(cmd).toBe(ImprovCmd.WIFI_SETTINGS);
    expect(strings[0]).toBe("http://192.168.1.50/");
  });
});

describe("Web Serial scan lifecycle", () => {
  it("authorizes one exact payload before reprovisioning an enrolled display", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const commands: number[] = [];
    const challenge = "00112233445566778899aabbccddeeff";
    const rpcResult = (cmd: number, strings: string[]) => {
      const encoded = strings.flatMap((value) => {
        const bytes = Array.from(new TextEncoder().encode(value));
        return [bytes.length, ...bytes];
      });
      return encodeFrame(ImprovType.RPC_RESULT, [cmd, encoded.length, ...encoded]);
    };
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const cmd = chunk[9];
        commands.push(cmd!);
        if (cmd === ImprovCmd.GET_STATE) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.READY]));
        } else if (cmd === ImprovCmd.GET_PROVISIONING_SECURITY) {
          controller.enqueue(
            rpcResult(ImprovCmd.GET_PROVISIONING_SECURITY, [
              "1",
              "A1B2C3D4E5F6",
              challenge,
              "locked",
            ])
          );
        } else if (cmd === ImprovCmd.AUTHORIZE_PROVISIONING) {
          controller.enqueue(rpcResult(ImprovCmd.AUTHORIZE_PROVISIONING, ["authorized"]));
        } else if (cmd === ImprovCmd.WIFI_SETTINGS) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONED]));
          controller.enqueue(rpcResult(ImprovCmd.WIFI_SETTINGS, ["https://vellum.test"]));
        }
      },
    });
    const port = { readable, writable, async open() {}, async close() {} };
    vi.stubGlobal("navigator", { serial: { requestPort: async () => port } });

    const session = await SerialProvisioningSession.connect();
    const provisionedAtUnix = 1_786_291_200;
    const authorize = vi.fn(async (request: UsbProvisioningAuthorizationRequest) => {
      const payload = wifiSettingsPayload(
        "Office",
        "secret",
        "https://vellum.test",
        undefined,
        "",
        provisionedAtUnix
      );
      expect(request).toEqual({
        mac: "A1B2C3D4E5F6",
        challenge,
        payloadDigest: createHash("sha256").update(payload).digest("hex"),
      });
      return "aa".repeat(32);
    });

    await expect(
      session.provision({
        ssid: "Office",
        password: "secret",
        serverUrl: "https://vellum.test",
        ntpServer: "",
        provisionedAtUnix,
        authorize,
        timeoutMs: 500,
      })
    ).resolves.toEqual({ ok: true, redirectUrl: "https://vellum.test" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(commands.indexOf(ImprovCmd.AUTHORIZE_PROVISIONING)).toBeLessThan(
      commands.indexOf(ImprovCmd.WIFI_SETTINGS)
    );
    await session.disconnect();
  });

  it("reuses one open port for repeated scans and provisioning", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let openCount = 0;
    let closeCount = 0;
    let pickerCount = 0;
    const rpcResult = (cmd: number, strings: string[]) => {
      const encoded = strings.flatMap((value) => {
        const bytes = Array.from(new TextEncoder().encode(value));
        return [bytes.length, ...bytes];
      });
      return encodeFrame(ImprovType.RPC_RESULT, [cmd, encoded.length, ...encoded]);
    };
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const cmd = chunk[9];
        if (cmd === ImprovCmd.GET_STATE) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.READY]));
        } else if (cmd === ImprovCmd.SCAN_WIFI) {
          controller.enqueue(rpcResult(ImprovCmd.SCAN_WIFI, ["Office", "-42", "YES"]));
          controller.enqueue(rpcResult(ImprovCmd.SCAN_WIFI, []));
        } else if (cmd === ImprovCmd.WIFI_SETTINGS) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONING]));
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.PROVISIONED]));
          controller.enqueue(rpcResult(ImprovCmd.WIFI_SETTINGS, ["https://vellum.test/devices/1"]));
        }
      },
    });
    const port = {
      readable,
      writable,
      async open() {
        openCount += 1;
      },
      async close() {
        closeCount += 1;
      },
    };
    vi.stubGlobal("navigator", {
      serial: {
        requestPort: async () => {
          pickerCount += 1;
          return port;
        },
      },
    });

    const session = await SerialProvisioningSession.connect();
    await expect(session.scanNetworks({ timeoutMs: 500 })).resolves.toMatchObject({ ok: true });
    await expect(session.scanNetworks({ timeoutMs: 500 })).resolves.toMatchObject({ ok: true });
    await expect(
      session.provision({ ssid: "Office", password: "secret", timeoutMs: 500 })
    ).resolves.toEqual({ ok: true, redirectUrl: "https://vellum.test/devices/1" });
    expect(session.connected).toBe(true);
    await session.disconnect();

    expect(pickerCount).toBe(1);
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(session.connected).toBe(false);
  });

  it("keeps a native USB port open from readiness probe through scan", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let openCount = 0;
    let closeCount = 0;
    const rpcResult = (strings: string[]) => {
      const encoded = strings.flatMap((value) => {
        const bytes = Array.from(new TextEncoder().encode(value));
        return [bytes.length, ...bytes];
      });
      return encodeFrame(ImprovType.RPC_RESULT, [ImprovCmd.SCAN_WIFI, encoded.length, ...encoded]);
    };

    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const cmd = chunk[9];
        if (cmd === ImprovCmd.GET_STATE) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.READY]));
        } else if (cmd === ImprovCmd.SCAN_WIFI) {
          controller.enqueue(rpcResult(["Office", "-42", "YES"]));
          controller.enqueue(rpcResult([]));
        }
      },
    });
    const port = {
      readable,
      writable,
      async open() {
        openCount += 1;
      },
      async close() {
        closeCount += 1;
      },
      async setSignals() {},
    };
    vi.stubGlobal("navigator", {
      serial: { requestPort: async () => port },
    });

    await expect(scanNetworksOverSerial({ timeoutMs: 500 })).resolves.toEqual({
      ok: true,
      networks: [{ ssid: "Office", rssi: -42, secured: true }],
    });
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
  });

  it("does not issue a second control-line reset after opening the port", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const signalCalls: unknown[] = [];
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (chunk[9] === ImprovCmd.GET_STATE) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.READY]));
        } else if (chunk[9] === ImprovCmd.SCAN_WIFI) {
          controller.enqueue(encodeFrame(ImprovType.RPC_RESULT, [ImprovCmd.SCAN_WIFI, 0]));
        }
      },
    });
    const port = {
      readable,
      writable,
      async open() {},
      async close() {},
      async setSignals(signals: unknown) {
        signalCalls.push(signals);
      },
    };
    vi.stubGlobal("navigator", { serial: { requestPort: async () => port } });

    await expect(scanNetworksOverSerial({ timeoutMs: 500 })).resolves.toMatchObject({ ok: true });
    expect(signalCalls).toEqual([]);
  });
});

/**
 * A port already held by ESP Web Tools or another tab is the most common
 * provisioning failure, and it does NOT surface at requestPort() — selecting a
 * port always succeeds. It fails at port.open(), where the browser throws a bare
 * DOMException that says nothing about closing the flash tool.
 */
describe("serial error explanations", () => {
  it("recognises the wordings browsers actually use for a busy port", () => {
    // Chrome: another context holds the port.
    expect(describeSerialError(new Error("Failed to open serial port."))).toMatch(/already in use/);
    // Chrome: opening a port this tab already opened.
    expect(describeSerialError(new Error("The port is already open."))).toMatch(/already in use/);
    // Both point at the fix rather than restating the failure.
    expect(describeSerialError(new Error("Failed to open serial port."))).toMatch(
      /Close the flash tool/
    );
  });

  it("passes an unrelated fault through verbatim", () => {
    // An invented explanation for an unknown fault is worse than the browser's.
    expect(describeSerialError(new Error("The device has been lost."))).toBe(
      "The device has been lost."
    );
  });

  it("survives a non-Error throw", () => {
    expect(describeSerialError("nope")).toBe("Serial I/O error.");
    expect(describeSerialError(undefined)).toBe("Serial I/O error.");
  });

  it("explains a busy port instead of leaking the DOMException, end to end", async () => {
    const port = {
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
      async open() {
        throw new Error("Failed to open serial port.");
      },
      async close() {},
      async setSignals() {},
    };
    vi.stubGlobal("navigator", { serial: { requestPort: async () => port } });

    const result = await scanNetworksOverSerial({ timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already in use/);
    expect(result.error).not.toMatch(/Failed to open serial port/);
  });

  it("does not blame another tab when the operator simply cancelled the picker", async () => {
    // The regression this change exists for, on the path that had it:
    // provisionOverSerial's requestPort() catch told the operator to close other
    // tabs, but requestPort() rejects when the dialog is DISMISSED — so cancelling
    // produced advice about a problem the operator did not have.
    vi.stubGlobal("navigator", {
      serial: {
        requestPort: async () => {
          throw new Error("No port selected by the user.");
        },
      },
    });

    const result = await provisionOverSerial({ ssid: "Office", password: "secret" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No serial port selected/);
    expect(result.error).not.toMatch(/another tab|already in use/);
  });

  it("explains a busy port during provisioning too", async () => {
    const port = {
      readable: new ReadableStream<Uint8Array>(),
      writable: new WritableStream<Uint8Array>(),
      async open() {
        throw new Error("The port is already open.");
      },
      async close() {},
      async setSignals() {},
    };
    vi.stubGlobal("navigator", { serial: { requestPort: async () => port } });

    const result = await provisionOverSerial({
      ssid: "Office",
      password: "secret",
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already in use/);
    expect(result.error).not.toMatch(/The port is already open/);
  });
});

/* The distinction these cover is the whole point: "the display told us it does
 * not know the command" and "the display said nothing" both used to surface as
 * "this firmware predates protected USB provisioning", which is a false
 * statement about current firmware and sends the operator to reflash a display
 * whose real problem is the connection. */
describe("provisioning security probe diagnosis", () => {
  const rpcResult = (cmd: number, strings: string[]) => {
    const encoded = strings.flatMap((value) => {
      const bytes = Array.from(new TextEncoder().encode(value));
      return [bytes.length, ...bytes];
    });
    return encodeFrame(ImprovType.RPC_RESULT, [cmd, encoded.length, ...encoded]);
  };

  /** A fake display that answers GET_STATE, then whatever `reply` decides. */
  async function connectWith(reply: (enqueue: (frame: Uint8Array) => void) => void) {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const cmd = chunk[9];
        if (cmd === ImprovCmd.GET_STATE) {
          controller.enqueue(encodeFrame(ImprovType.CURRENT_STATE, [ImprovState.READY]));
        } else if (cmd === ImprovCmd.GET_PROVISIONING_SECURITY) {
          reply((frame) => controller.enqueue(frame));
        }
      },
    });
    const port = { readable, writable, async open() {}, async close() {} };
    vi.stubGlobal("navigator", { serial: { requestPort: async () => port } });
    return SerialProvisioningSession.connect();
  }

  it("reports firmware that answers UNKNOWN_CMD as genuinely unsupported", async () => {
    const session = await connectWith((enqueue) =>
      enqueue(encodeFrame(ImprovType.ERROR_STATE, [ImprovError.UNKNOWN_CMD]))
    );
    const security = await session.getProvisioningSecurity();

    expect(security.supported).toBe(false);
    expect(security.failure).toBe("unsupported");
    await session.disconnect();
  });

  it("reports silence as unanswered rather than blaming the firmware", async () => {
    // Answers GET_STATE so the connection succeeds, then never replies.
    const session = await connectWith(() => {});
    const security = await session.getProvisioningSecurity();

    expect(security.supported).toBe(false);
    expect(security.failure).toBe("unanswered");
    await session.disconnect();
  }, 10_000);

  it("carries no failure when the display answers properly", async () => {
    const session = await connectWith((enqueue) =>
      enqueue(rpcResult(ImprovCmd.GET_PROVISIONING_SECURITY, ["1", "58E6C50F4054", "", "unlocked"]))
    );
    const security = await session.getProvisioningSecurity();

    expect(security).toMatchObject({ supported: true, locked: false, mac: "58E6C50F4054" });
    expect(security.failure).toBeUndefined();
    await session.disconnect();
  });
});
