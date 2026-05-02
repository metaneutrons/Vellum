// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useMemo, useRef, useEffect } from "react";

/** All IANA timezones from the runtime */
const ALL_TIMEZONES = Intl.supportedValuesOf("timeZone");

interface TimezonePickerProps {
  value: string;
  onChange: (tz: string) => void;
  label?: string;
  className?: string;
}

export function TimezonePicker({ value, onChange, label, className }: TimezonePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!search) return ALL_TIMEZONES;
    const q = search.toLowerCase();
    return ALL_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q));
  }, [search]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className={className} ref={containerRef}>
      {label && <label className="block text-sm font-medium mb-1">{label}</label>}
      <button
        type="button"
        className="w-full border rounded px-3 py-2 text-sm text-left bg-white dark:bg-gray-800 hover:border-gray-400"
        onClick={() => { setOpen(!open); setSearch(""); }}
      >
        {value || "Select timezone…"}
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-72 bg-white dark:bg-gray-800 border rounded shadow-lg">
          <input
            ref={inputRef}
            type="text"
            className="w-full border-b px-3 py-2 text-sm outline-none"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="max-h-60 overflow-y-auto">
            {filtered.slice(0, 100).map((tz) => (
              <li
                key={tz}
                className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 dark:hover:bg-gray-700 ${tz === value ? "bg-blue-100 dark:bg-gray-600 font-medium" : ""}`}
                onClick={() => { onChange(tz); setOpen(false); }}
              >
                {tz.replace(/_/g, " ")}
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-gray-400">No results</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
