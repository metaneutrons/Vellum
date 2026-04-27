// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#0f1117" }}>
      <form action={formAction} className="w-full max-w-sm" style={{ padding: 32 }}>
        <div className="flex justify-center mb-8">
          <img src="/vellum-logo.svg" alt="Vellum" width={200} height={200} style={{ filter: "brightness(0) invert(1)" }} />
        </div>

        {state?.error && (
          <div className="mb-4 p-3 rounded-lg text-sm text-center" style={{ background: "rgba(239,68,68,0.1)", color: "#f87171" }}>
            {state.error}
          </div>
        )}

        <div className="rounded-xl overflow-hidden" style={{ background: "#1c1f2e", border: "1px solid #2a2d3e" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #2a2d3e" }}>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "#64748b" }}>Username</label>
            <input
              name="user"
              type="text"
              required
              autoFocus
              className="w-full bg-transparent text-sm outline-none"
              style={{ color: "#e2e8f0" }}
            />
          </div>
          <div style={{ padding: "16px 20px" }}>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "#64748b" }}>Password</label>
            <input
              name="pass"
              type="password"
              required
              className="w-full bg-transparent text-sm outline-none"
              style={{ color: "#e2e8f0" }}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="w-full mt-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium transition-colors"
        >
          {pending ? "Signing in..." : "Sign in"}
        </button>

        <p className="text-center mt-6 text-xs" style={{ color: "#374151" }}>
          E-Ink Display Management
        </p>
      </form>
    </div>
  );
}
