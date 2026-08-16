// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { forwardRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

const inputBase =
  "w-full min-h-11 px-3.5 rounded-md bg-surface-secondary border border-separator " +
  "text-[15px] text-label placeholder:text-label-tertiary focus-ring " +
  "focus:border-accent transition disabled:opacity-40";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`${inputBase} ${className}`} {...props} />;
  }
);

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-label">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[13px] text-red">{error}</p>
      ) : hint ? (
        <p className="text-[13px] text-label-secondary">{hint}</p>
      ) : null}
    </div>
  );
}
