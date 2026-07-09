import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@napi-rs/canvas"],
  allowedDevOrigins: ["192.168.16.5", "192.168.18.1"],
  async headers() {
    // Baseline security headers on every response. NOTE: the CSP here is a
    // deliberately non-breaking subset (clickjacking / <base> / plugins / form
    // hijack). A full script-src/style-src lockdown needs per-request nonces and
    // prod-only handling (Next's dev HMR uses eval) — tracked in ROADMAP.
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'" },
    ];
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Permissive CORS only for the device-facing API (ESP32 clients send
        // no Origin). Admin + health stay same-origin — no
        // Access-Control-Allow-Origin, so browsers block cross-site calls.
        source: "/api/v1/ink/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, X-Device-Token, X-API-Key" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
