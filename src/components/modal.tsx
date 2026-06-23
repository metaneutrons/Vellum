// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  wide?: boolean;
}

export function Modal({ open, onClose, title, children, footer, onSubmit, wide }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) onSubmit();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, onSubmit]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 material-overlay flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className={`bg-surface rounded-xl shadow-e2 border border-separator w-full max-h-[90vh] flex flex-col ${wide ? "max-w-5xl" : "max-w-lg"}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center px-6 py-4 border-b border-separator">
          <h2 className="text-lg font-bold text-label">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="text-label-secondary hover:text-label leading-none rounded-md focus-ring">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-separator flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
