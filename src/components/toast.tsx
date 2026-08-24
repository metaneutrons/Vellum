// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: ToastType, message: string) => {
    const id = nextId++;
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  /* The token colours rather than the raw palette, so a toast matches the rest of
   * the surface it appears over. White stays the foreground: all three grounds are
   * saturated in both themes, and `--color-green` at 3.0:1 against white is the
   * weakest of them, which is the WCAG floor for text this size. */
  const colors: Record<ToastType, string> = {
    success: "bg-green",
    error: "bg-red",
    info: "bg-label",
  };

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${colors[t.type]} text-white px-4 py-3 rounded-lg shadow-lg text-sm flex justify-between items-center`}
          >
            <span>{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="ml-3 opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
