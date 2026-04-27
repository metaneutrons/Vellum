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
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  danger: "text-red-600 border border-red-200 hover:bg-red-50",
  ghost: "border hover:bg-gray-50",
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
