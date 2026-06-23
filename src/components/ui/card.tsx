// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { HTMLAttributes } from "react";

/** Elevated surface card — the Aurora grouped-content container. */
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-surface rounded-2xl shadow-e1 border border-separator/60 ${className}`}
      {...props}
    />
  );
}
