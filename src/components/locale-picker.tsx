// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

const LOCALES = [
  { code: "de", flag: "🇩🇪", label: "Deutsch" },
  { code: "en", flag: "🇬🇧", label: "English" },
  { code: "fr", flag: "🇫🇷", label: "Français" },
  { code: "it", flag: "🇮🇹", label: "Italiano" },
  { code: "es", flag: "🇪🇸", label: "Español" },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

interface LocalePickerProps {
  value: string;
  onChange: (locale: string) => void;
  label?: string;
  className?: string;
}

export function LocalePicker({ value, onChange, label, className }: LocalePickerProps) {
  return (
    <div className={className}>
      {label && <label className="block text-sm font-medium text-label mb-1.5">{label}</label>}
      <select
        className="w-full min-h-11 px-3 rounded-md bg-surface-secondary border border-separator text-[15px] text-label focus-ring"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.flag} {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
