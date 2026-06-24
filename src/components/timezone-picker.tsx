// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { ChevronsUpDown } from "lucide-react";

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
    <div className={`relative ${className ?? ""}`} ref={containerRef}>
      {label && <label className="block text-sm font-medium text-label mb-1.5">{label}</label>}
      <button
        type="button"
        className="w-full min-h-11 px-3 rounded-md bg-surface-secondary border border-separator text-[15px] text-label text-left focus-ring transition hover:bg-surface-hover flex items-center justify-between gap-2"
        onClick={() => { setOpen(!open); setSearch(""); }}
      >
        <span className={value ? "" : "text-label-tertiary"}>{value || "Select timezone…"}</span>
        <ChevronsUpDown size={16} className="text-label-tertiary shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-72 bg-surface border border-separator rounded-md shadow-e3 overflow-hidden">
          <input
            ref={inputRef}
            type="text"
            className="w-full px-3 py-2 text-[15px] bg-surface text-label placeholder:text-label-tertiary border-b border-separator outline-none focus-ring"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="max-h-60 overflow-y-auto">
            {filtered.slice(0, 100).map((tz) => (
              <li
                key={tz}
                className={`px-3 py-1.5 text-[13px] cursor-pointer hover:bg-surface-secondary ${tz === value ? "bg-accent-soft text-accent font-medium" : "text-label"}`}
                onClick={() => { onChange(tz); setOpen(false); }}
              >
                {tz.replace(/_/g, " ")}
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-[13px] text-label-tertiary">No results</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
