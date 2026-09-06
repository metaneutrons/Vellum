// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useTranslations } from "next-intl";

export default function AdminError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("error");

  /* React hands the boundary whatever was thrown, and the `Error` in the prop type
   * is Next's convention rather than a promise. A thrown string carries no
   * `message`, so reading it through `unknown` keeps the error page from throwing
   * an error of its own. */
  const thrown: unknown = error;
  const message = thrown instanceof Error ? thrown.message : String(thrown);

  const isDbError =
    message.includes("connect") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Failed query") ||
    message.includes("timeout");

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">{isDbError ? "🔌" : "⚠️"}</div>
        <h2 className="text-xl font-bold mb-2">
          {isDbError ? t("dbUnavailable") : t("somethingWrong")}
        </h2>
        <p className="text-label-secondary mb-6">
          {isDbError ? t("dbHint") : message || t("unexpected")}
        </p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-accent text-on-accent rounded-md hover:bg-accent-hover transition"
        >
          {t("retry")}
        </button>
      </div>
    </div>
  );
}
