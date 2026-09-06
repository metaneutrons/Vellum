// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  /* React hands the boundary whatever was thrown, and the `Error` in the prop type
   * is Next's convention rather than a promise. A thrown string carries no
   * `message`, so reading it through `unknown` keeps the error page from throwing
   * an error of its own. */
  const thrown: unknown = error;
  const message = thrown instanceof Error ? thrown.message : String(thrown);

  const isDbError =
    message.includes("connect") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Failed query") ||
    message.includes("timeout");

  return (
    <html>
      <body
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "system-ui",
          background: "#111",
          color: "#fff",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>{isDbError ? "🔌" : "⚠️"}</div>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>
            {isDbError ? "Database Unavailable" : "Something went wrong"}
          </h2>
          <p style={{ color: "#999", marginBottom: 24 }}>
            {isDbError
              ? "Cannot connect to the database. Please ensure PostgreSQL is running."
              : message || "An unexpected error occurred."}
          </p>
          <button
            onClick={reset}
            style={{
              padding: "8px 20px",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
