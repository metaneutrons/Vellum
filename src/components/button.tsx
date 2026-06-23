// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { type ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "danger" | "ghost";
  pending?: boolean;
  pendingText?: string;
  size?: "sm" | "md";
}

const styles = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  danger: "text-red border border-red/30 hover:bg-red/10",
  ghost: "border border-separator hover:bg-surface-secondary",
};

export function Button({
  variant = "primary", pending, pendingText, size = "md", children, disabled, className = "", ...props
}: ButtonProps) {
  const sizeClass = size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm";
  return (
    <button
      disabled={disabled || pending}
      className={`${sizeClass} rounded disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    >
      {pending ? (pendingText ?? "Saving...") : children}
    </button>
  );
}
