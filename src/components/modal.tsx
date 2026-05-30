// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: () => void;
  wide?: boolean;
}

/**
 * A responsive, accessible modal dialog component.
 *
 * Implements a glassmorphism overlay and soft drop shadows for an
 * Apple-style aesthetic. It handles keyboard events (Escape to close, Cmd/Ctrl+Enter to submit)
 * and click-outside-to-close behavior.
 *
 * @param {Object} props - The modal props.
 * @param {boolean} props.open - Whether the modal is visible.
 * @param {() => void} props.onClose - Callback triggered when the modal should close.
 * @param {string} props.title - The title displayed in the modal header.
 * @param {ReactNode} props.children - The main content of the modal.
 * @param {ReactNode} [props.footer] - Optional footer content (e.g., action buttons).
 * @param {() => void} [props.onSubmit] - Optional callback triggered on Cmd/Ctrl+Enter.
 * @param {boolean} [props.wide=false] - Whether the modal should use a wider layout.
 * @returns {JSX.Element | null} The rendered modal or null if not open.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  onSubmit,
  wide,
}: ModalProps) {
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
      className="fixed inset-0 bg-black/50 backdrop-blur-md flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white rounded-[20px] shadow-2xl transition-all transform scale-100 w-full max-h-[90vh] flex flex-col ${wide ? "max-w-5xl" : "max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center px-6 py-4 border-b">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            &times;
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
