// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { dbResilience } from "@/db";

// a route handler
// is declared async by Next.js convention even when its body is synchronous.
// eslint-disable-next-line @typescript-eslint/require-await
export async function GET() {
  const state = dbResilience.getState();
  const status = state.circuit === "open" ? 503 : state.connected ? 200 : 503;

  return Response.json(
    {
      status: state.connected ? "ok" : "degraded",
      database: state,
    },
    { status }
  );
}
