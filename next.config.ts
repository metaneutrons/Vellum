import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@napi-rs/canvas"],
  allowedDevOrigins: ["192.168.16.5", "192.168.18.1"],
  async headers() {
    return [
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
