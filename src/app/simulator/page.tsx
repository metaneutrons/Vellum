// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { notFound } from "next/navigation";
import { SimulatorClient } from "./client";

/**
 * reTerminal E1002 Simulator — development only.
 * Returns 404 in production builds.
 */
export default function SimulatorPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }
  return <SimulatorClient />;
}
