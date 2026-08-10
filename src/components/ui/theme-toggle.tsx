// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

type Theme = "light" | "dark" | "system";
const OPTIONS: Theme[] = ["light", "dark", "system"];

function apply(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Light / Dark / Auto segmented control, persisted to localStorage. */
export function ThemeToggle() {
  const t = useTranslations("nav");
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem("vellum-theme");
    const saved: Theme = stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
    setTheme(saved);
    // The inline layout script prevents a flash on a normal document load.
    // Apply again after hydration: this also recovers the correct system
    // appearance when a browser restores a page from its cache or blocks the
    // early inline script during a navigation.
    apply(saved);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if ((localStorage.getItem("vellum-theme") || "system") === "system") apply("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    localStorage.setItem("vellum-theme", next);
    apply(next);
  }

  return (
    <div role="radiogroup" aria-label={t("appearance")} className="inline-flex p-0.5 bg-fill-tertiary rounded-md gap-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o}
          role="radio"
          aria-checked={theme === o}
          onClick={() => choose(o)}
          className={`px-2.5 min-h-7 text-[13px] font-medium rounded-[7px] focus-ring transition ${
            theme === o ? "bg-surface text-label shadow-e1" : "text-label-secondary hover:text-label"
          }`}
        >
          {t(o === "light" ? "lightMode" : o === "dark" ? "darkMode" : "systemMode")}
        </button>
      ))}
    </div>
  );
}
