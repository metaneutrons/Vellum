import { describe, expect, it } from "vitest";

import { isBlockedAddress } from "@/lib/safe-fetch";

/* The octet ranges had no direct coverage: safe-fetch-pinning.test.ts drives the
 * fetch wrapper, not the predicate. Every range is checked one address inside and
 * one outside, because an off-by-one here either exposes an internal network or
 * blocks a legitimate server, and neither shows up in a normal test run. */
describe("isBlockedAddress", () => {
  const blocked = [
    ["0.0.0.0", "this-host"],
    ["10.0.0.1", "private 10/8"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "cloud metadata"],
    ["172.16.0.1", "first address of 172.16/12"],
    ["172.31.255.255", "last address of 172.16/12"],
    ["192.168.1.1", "private 192.168/16"],
    ["100.64.0.1", "first address of CGNAT 100.64/10"],
    ["100.127.255.255", "last address of CGNAT 100.64/10"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["fe80::1", "IPv6 link-local"],
    ["fd00::1", "IPv6 unique-local"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ] as const;

  const allowed = [
    ["8.8.8.8", "public resolver"],
    ["172.15.0.1", "just below 172.16/12"],
    ["172.32.0.1", "just above 172.16/12"],
    ["169.253.0.1", "just below link-local"],
    ["100.63.255.255", "just below CGNAT"],
    ["100.128.0.1", "just above CGNAT"],
    ["223.255.255.255", "just below multicast"],
    ["192.167.1.1", "just below 192.168/16"],
    ["2606:4700::1111", "public IPv6"],
  ] as const;

  for (const [ip, why] of blocked) {
    it(`blocks ${ip} (${why})`, () => expect(isBlockedAddress(ip)).toBe(true));
  }
  for (const [ip, why] of allowed) {
    it(`allows ${ip} (${why})`, () => expect(isBlockedAddress(ip)).toBe(false));
  }
});
