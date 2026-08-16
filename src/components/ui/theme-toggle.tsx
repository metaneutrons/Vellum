// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sun, Moon, Contrast } from "lucide-react";

type Theme = "light" | "dark" | "system";

/**
 * Icon per appearance, matching the platform's own vocabulary: sun, moon, and a
 * half-filled circle for "follow the system" (Apple's circle.lefthalf.filled).
 *
 * The labels stay as accessible names and tooltips rather than visible text — as
 * three spelled-out words the control was wider than everything around it, and in
 * German ("Heller Modus", "Dunkler Modus") it dominated the login page.
 */
const OPTIONS: { value: Theme; Icon: typeof Sun; key: string }[] = [
  { value: "light", Icon: Sun, key: "lightMode" },
  { value: "dark", Icon: Moon, key: "darkMode" },
  { value: "system", Icon: Contrast, key: "systemMode" },
];

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
    const saved: Theme =
      stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
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
    <div
      role="radiogroup"
      aria-label={t("appearance")}
      className="inline-flex p-0.5 bg-fill-tertiary rounded-lg gap-0.5"
    >
      {OPTIONS.map(({ value, Icon, key }) => {
        const label = t(key);
        return (
          <button
            key={value}
            role="radio"
            aria-checked={theme === value}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={`grid place-items-center size-7 rounded-[7px] focus-ring transition ${
              theme === value
                ? "bg-surface text-label shadow-e1"
                : "text-label-secondary hover:text-label"
            }`}
          >
            <Icon size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
