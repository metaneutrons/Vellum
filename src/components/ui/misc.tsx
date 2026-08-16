// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import type { ReactNode } from "react";

/** Apple segmented control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex p-0.5 bg-fill-tertiary rounded-md gap-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 min-h-8 text-[13px] font-medium rounded-[7px] focus-ring transition ${
            value === o.value
              ? "bg-surface text-label shadow-e1"
              : "text-label-secondary hover:text-label"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Loading placeholder. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-md bg-fill-tertiary animate-pulse motion-reduce:animate-none ${className}`}
    />
  );
}

/** Empty / zero-state. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-16 px-6">
      {icon && (
        <div className="size-12 rounded-2xl bg-fill-tertiary text-label-secondary grid place-items-center text-2xl">
          {icon}
        </div>
      )}
      <h3 className="text-xl font-semibold text-label">{title}</h3>
      {description && <p className="text-[15px] text-label-secondary max-w-sm">{description}</p>}
      {action}
    </div>
  );
}
