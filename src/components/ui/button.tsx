// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "filled" | "tinted" | "plain" | "gray" | "destructive";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-md select-none " +
  "whitespace-nowrap focus-ring transition active:scale-[0.97] " +
  "disabled:opacity-40 disabled:pointer-events-none";

const sizes: Record<Size, string> = {
  sm: "min-h-8 px-3 text-sm",
  md: "min-h-11 px-4 text-[15px]",
  lg: "min-h-12 px-5 text-base",
};

const variants: Record<Variant, string> = {
  filled: "bg-accent text-on-accent shadow-e1 hover:bg-accent-hover active:bg-accent-pressed",
  tinted: "bg-accent-soft text-accent hover:opacity-80",
  plain: "text-accent hover:bg-fill-tertiary",
  gray: "bg-fill-tertiary text-label hover:bg-fill-secondary",
  destructive: "bg-red text-white shadow-e1 hover:brightness-110 active:brightness-95",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "filled", size = "md", loading = false, leading, trailing, children, className = "", disabled, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    >
      {loading && (
        <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin motion-reduce:animate-none" />
      )}
      {!loading && leading}
      {children && <span>{children}</span>}
      {!loading && trailing}
    </button>
  );
});
