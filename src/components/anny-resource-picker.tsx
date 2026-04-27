// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useEffect, useRef } from "react";

interface Resource {
  id: string;
  name: string;
  description?: string;
}

interface Props {
  providerId: string;
  value: string;
  valueName?: string;
  onChange: (id: string, name: string) => void;
  placeholder?: string;
}

/**
 * Searchable dropdown that fetches anny resources with debounced search.
 * Apple-style: type to search, click to select, shows selected value.
 */
export function AnnyResourcePicker({ providerId, value, valueName, onChange, placeholder = "Search rooms..." }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState(valueName ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch resources on search change
  useEffect(() => {
    if (!providerId || !open) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ providerId });
        if (search) params.set("search", search);
        const res = await fetch(`/api/v1/admin/anny-resources?${params}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.resources ?? []);
        }
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [providerId, search, open]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function select(r: Resource) {
    onChange(r.id, r.name);
    setSelectedName(r.name);
    setSearch("");
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Display selected value or search input */}
      {value && !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full border rounded px-3 py-2 text-sm text-left bg-white hover:bg-gray-50 flex justify-between items-center"
        >
          <span>{selectedName || value}</span>
          <span className="text-gray-400 text-xs">Change</span>
        </button>
      ) : (
        <input
          className="w-full border rounded px-3 py-2 text-sm"
          placeholder={placeholder}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          aria-label="Search rooms"
        />
      )}

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-400">
              {search ? "No rooms found" : "Type to search or scroll to browse"}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => select(r)}
              className={`w-full text-left px-3 py-2 hover:bg-blue-50 text-sm border-b last:border-0 ${r.id === value ? "bg-blue-50 font-medium" : ""}`}
            >
              <div className="font-medium">{r.name}</div>
              {r.description && <div className="text-xs text-gray-400 truncate">{r.description}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
