#!/usr/bin/env node
/**
 * Announces the Vellum server via mDNS so ESP32 devices
 * can auto-discover it on the local network.
 *
 * Service: _vellum._tcp
 * Hostname: vellum.local
 */

import mdns from "multicast-dns";
import { networkInterfaces } from "os";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOSTNAME = "vellum.local";
const SERVICE = "_vellum._tcp.local";

function getLocalIPs() {
  const ips = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const addr of iface ?? []) {
      if (addr.family === "IPv4" && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

const m = mdns();
const ips = getLocalIPs();

m.on("query", (query) => {
  const dominated = query.questions.some(
    (q) => q.name === SERVICE || q.name === HOSTNAME
  );
  if (!dominated) return;

  m.respond({
    answers: [
      { name: SERVICE, type: "PTR", data: `vellum.${SERVICE}` },
      { name: `vellum.${SERVICE}`, type: "SRV", data: { port: PORT, target: HOSTNAME } },
      ...ips.map((ip) => ({ name: HOSTNAME, type: "A", data: ip })),
    ],
  });
});

console.log(`[mDNS] Announcing ${SERVICE} on port ${PORT}`);
console.log(`[mDNS] IPs: ${ips.join(", ")}`);
console.log(`[mDNS] Hostname: ${HOSTNAME}`);
