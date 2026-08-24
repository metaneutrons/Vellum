// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useTranslations } from "next-intl";

export default function LoginError({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("common");
  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center max-w-md">
        <div className="text-5xl mb-4">⚠️</div>
        <h2 className="text-xl font-bold mb-2">{t("serviceUnavailable")}</h2>
        <p className="text-label-secondary mb-6">{error.message || "Please try again later."}</p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-accent text-on-accent rounded-md hover:bg-accent-hover"
        >
          {t("retry")}
        </button>
      </div>
    </div>
  );
}
