// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

const TIMEZONES = [
  { value: "Europe/Berlin", label: "🇩🇪 Berlin (CET/CEST)" },
  { value: "Europe/Zurich", label: "🇨🇭 Zürich (CET/CEST)" },
  { value: "Europe/Vienna", label: "🇦🇹 Wien (CET/CEST)" },
  { value: "Europe/London", label: "🇬🇧 London (GMT/BST)" },
  { value: "Europe/Paris", label: "🇫🇷 Paris (CET/CEST)" },
  { value: "Europe/Rome", label: "🇮🇹 Rom (CET/CEST)" },
  { value: "Europe/Madrid", label: "🇪🇸 Madrid (CET/CEST)" },
  { value: "Europe/Amsterdam", label: "🇳🇱 Amsterdam (CET/CEST)" },
  { value: "Europe/Brussels", label: "🇧🇪 Brüssel (CET/CEST)" },
  { value: "Europe/Stockholm", label: "🇸🇪 Stockholm (CET/CEST)" },
  { value: "Europe/Helsinki", label: "🇫🇮 Helsinki (EET/EEST)" },
  { value: "Europe/Athens", label: "🇬🇷 Athen (EET/EEST)" },
  { value: "Europe/Warsaw", label: "🇵🇱 Warschau (CET/CEST)" },
  { value: "Europe/Prague", label: "🇨🇿 Prag (CET/CEST)" },
  { value: "America/New_York", label: "🇺🇸 New York (EST/EDT)" },
  { value: "America/Chicago", label: "🇺🇸 Chicago (CST/CDT)" },
  { value: "America/Los_Angeles", label: "🇺🇸 Los Angeles (PST/PDT)" },
  { value: "Asia/Tokyo", label: "🇯🇵 Tokyo (JST)" },
  { value: "Asia/Shanghai", label: "🇨🇳 Shanghai (CST)" },
  { value: "UTC", label: "🌐 UTC" },
] as const;

interface TimezonePickerProps {
  value: string;
  onChange: (tz: string) => void;
  label?: string;
  className?: string;
}

export function TimezonePicker({ value, onChange, label, className }: TimezonePickerProps) {
  return (
    <div className={className}>
      {label && <label className="block text-sm font-medium mb-1">{label}</label>}
      <select
        className="w-full border rounded px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {TIMEZONES.map((tz) => (
          <option key={tz.value} value={tz.value}>
            {tz.label}
          </option>
        ))}
      </select>
    </div>
  );
}
