"use client";

import { useActionState } from "react";
import { loginAction } from "./actions";

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#0f1117" }}>
      <form action={formAction} className="p-8 rounded-xl w-full max-w-sm" style={{ background: "#1c1f2e", border: "1px solid #2a2d3e" }}>
        <div className="flex justify-center mb-6">
          <img src="/vellum-logo.svg" alt="Vellum" width={160} height={160} style={{ filter: "brightness(0) invert(1)" }} />
        </div>

        {state?.error && (
          <div className="mb-4 p-3 rounded-lg text-sm" style={{ background: "rgba(239,68,68,0.1)", color: "#f87171" }}>
            {state.error}
          </div>
        )}

        <label className="block text-sm font-medium mb-1" style={{ color: "#94a3b8" }}>Username</label>
        <input
          name="user"
          type="text"
          required
          autoFocus
          className="w-full border rounded px-3 py-2 mb-4 text-sm"
        />

        <label className="block text-sm font-medium mb-1" style={{ color: "#94a3b8" }}>Password</label>
        <input
          name="pass"
          type="password"
          required
          className="w-full border rounded px-3 py-2 mb-6 text-sm"
        />

        <button
          type="submit"
          disabled={pending}
          className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
        >
          {pending ? "Logging in..." : "Login"}
        </button>
      </form>
    </div>
  );
}
