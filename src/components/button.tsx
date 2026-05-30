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
  primary:
    "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm",
  danger:
    "text-red-600 border border-red-200 hover:bg-red-50 active:bg-red-100 transition-colors shadow-sm",
  ghost:
    "border border-gray-200 hover:bg-gray-50 active:bg-gray-100 transition-colors shadow-sm",
};

/**
 * A styled button component that aligns with Apple's Human Interface Guidelines.
 *
 * It features smooth transitions, rounded corners, and clearly defined states
 * (hover, active, disabled) to provide a premium user experience.
 *
 * @param {Object} props - The button props, extending standard HTMLButtonElement props.
 * @param {"primary" | "danger" | "ghost"} [props.variant="primary"] - The visual style variant.
 * @param {boolean} [props.pending=false] - Whether the button is in a loading/pending state.
 * @param {string} [props.pendingText="Saving..."] - The text to display while pending.
 * @param {"sm" | "md"} [props.size="md"] - The size variant of the button.
 * @returns {JSX.Element} The rendered button component.
 */
export function Button({
  variant = "primary",
  pending,
  pendingText,
  size = "md",
  children,
  disabled,
  className = "",
  ...props
}: ButtonProps) {
  const sizeClass = size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2 text-sm";
  return (
    <button
      disabled={disabled || pending}
      className={`${sizeClass} rounded-lg disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    >
      {pending ? (pendingText ?? "Saving...") : children}
    </button>
  );
}
