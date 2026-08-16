// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useTranslations } from "next-intl";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchInput({ value, onChange, placeholder = "Search..." }: SearchInputProps) {
  const t = useTranslations("common");
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder === "Search..." ? t("search") : placeholder}
        aria-label={placeholder === "Search..." ? t("search") : placeholder}
        className="w-64 border rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label={t("clearSearch")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
        >
          ✕
        </button>
      )}
    </div>
  );
}
