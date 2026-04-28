// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface Resource { id: string; name: string; description?: string }

interface Props {
  providerId: string;
  resourceId: string;
  resourceName?: string;
  onChange: (resourceId: string, resourceName: string) => void;
}

/**
 * Searchable room picker — fetches resources from anny via provider credentials.
 */
export function AnnyResourcePicker({ providerId, resourceId, resourceName, onChange }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState(resourceName ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchResources = useCallback(async (q: string) => {
    if (!providerId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ providerId });
      if (q) params.set("search", q);
      const res = await fetch(`/api/v1/admin/anny-resources?${params}`);
      if (res.ok) setResults((await res.json()).resources ?? []);
    } catch { setResults([]); }
    setLoading(false);
  }, [providerId]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResources(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, open, fetchResources]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function select(r: Resource) {
    setSelectedName(r.name);
    setSearch("");
    setOpen(false);
    onChange(r.id, r.name);
  }

  return (
    <div ref={containerRef} className="relative">
      {resourceId && !open ? (
        <button type="button" onClick={() => { setOpen(true); fetchResources(""); }}
          className="w-full border rounded px-3 py-2 text-sm text-left bg-white hover:bg-gray-50 flex justify-between items-center">
          <span>{selectedName || resourceId}</span>
          <span className="text-gray-400 text-xs">Change</span>
        </button>
      ) : (
        <input className="w-full border rounded px-3 py-2 text-sm"
          placeholder="Search rooms..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); if (!results.length) fetchResources(""); }}
          aria-label="Search rooms" />
      )}
      {open && (
        <div className="absolute z-50 w-full mt-1 bg-white border rounded-lg shadow-lg max-h-64 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-400">{search ? "No rooms found" : "No resources"}</div>
          )}
          {results.map((r) => (
            <button key={r.id} type="button" onClick={() => select(r)}
              className={`w-full text-left px-3 py-2 hover:bg-blue-50 text-sm border-b last:border-0 ${r.id === resourceId ? "bg-blue-50 font-medium" : ""}`}>
              <div className="font-medium">{r.name}</div>
              {r.description && <div className="text-xs text-gray-400 truncate">{r.description}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
