// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";
const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

function apply(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Light / Dark / Auto segmented control, persisted to localStorage. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const saved = (localStorage.getItem("vellum-theme") as Theme) || "system";
    setTheme(saved);
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
    <div role="radiogroup" aria-label="Appearance" className="inline-flex p-0.5 bg-fill-tertiary rounded-md gap-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={theme === o.value}
          onClick={() => choose(o.value)}
          className={`px-2.5 min-h-7 text-[13px] font-medium rounded-[7px] focus-ring transition ${
            theme === o.value ? "bg-surface text-label shadow-e1" : "text-label-secondary hover:text-label"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
