// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "green" | "orange" | "red";

const tones: Record<Tone, string> = {
  neutral: "bg-fill text-label-secondary",
  accent: "bg-accent-soft text-accent",
  green: "bg-green/15 text-green",
  orange: "bg-orange/15 text-orange",
  red: "bg-red/15 text-red",
};

/**
 * Status pill — color is always paired with text/dot, never color-only.
 * @param dot show a leading status dot.
 */
export function StatusPill({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-full text-xs font-medium ${tones[tone]}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
