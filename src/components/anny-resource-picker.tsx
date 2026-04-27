// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface Organization { id: string; name: string; slug: string }
interface Resource { id: string; name: string; description?: string }

interface Props {
  providerId: string;
  organizationId: string;
  resourceId: string;
  resourceName?: string;
  onChange: (orgId: string, resourceId: string, resourceName: string) => void;
}

/**
 * Two-step anny picker:
 * 1. Load organizations — auto-select if only one
 * 2. Searchable room picker within selected org
 */
export function AnnyResourcePicker({ providerId, organizationId, resourceId, resourceName, onChange }: Props) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [orgLoading, setOrgLoading] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState(organizationId);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState(resourceName ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load organizations on mount
  useEffect(() => {
    if (!providerId) return;
    setOrgLoading(true);
    fetch(`/api/v1/admin/anny-organizations?providerId=${providerId}`)
      .then((r) => r.json())
      .then((data) => {
        const list = data.organizations ?? [];
        setOrgs(list);
        // Auto-select if only one org
        if (list.length === 1 && !selectedOrg) {
          setSelectedOrg(list[0].id);
          onChange(list[0].id, resourceId, selectedName);
        }
      })
      .catch(() => setOrgs([]))
      .finally(() => setOrgLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  // Fetch resources on search change
  const fetchResources = useCallback(async (q: string) => {
    if (!providerId || !selectedOrg) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ providerId, organizationId: selectedOrg });
      if (q) params.set("search", q);
      const res = await fetch(`/api/v1/admin/anny-resources?${params}`);
      if (res.ok) {
        const data = await res.json();
        setResults(data.resources ?? []);
      }
    } catch { setResults([]); }
    setLoading(false);
  }, [providerId, selectedOrg]);

  useEffect(() => {
    if (!open || !selectedOrg) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResources(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, open, selectedOrg, fetchResources]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function selectResource(r: Resource) {
    setSelectedName(r.name);
    setSearch("");
    setOpen(false);
    onChange(selectedOrg, r.id, r.name);
  }

  function selectOrg(orgId: string) {
    setSelectedOrg(orgId);
    setResults([]);
    onChange(orgId, "", "");
    setSelectedName("");
  }

  if (orgLoading) return <div className="text-sm text-gray-400 py-2">Loading organizations...</div>;

  return (
    <div className="space-y-3">
      {/* Organization selector — hidden if only one */}
      {orgs.length > 1 && (
        <div>
          <label className="block text-sm font-medium mb-1">Organization</label>
          <select className="w-full border rounded px-3 py-2 text-sm" value={selectedOrg}
            onChange={(e) => selectOrg(e.target.value)} aria-label="Organization">
            <option value="">— select organization —</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
      {orgs.length === 1 && (
        <div className="text-xs text-gray-400">Organization: {orgs[0].name}</div>
      )}
      {orgs.length === 0 && !orgLoading && (
        <div className="text-xs text-red-500">No organizations found — check API token</div>
      )}

      {/* Resource picker */}
      {selectedOrg && (
        <div ref={containerRef} className="relative">
          <label className="block text-sm font-medium mb-1">Room / Resource</label>
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
                <div className="px-3 py-2 text-sm text-gray-400">
                  {search ? "No rooms found" : "No resources available"}
                </div>
              )}
              {results.map((r) => (
                <button key={r.id} type="button" onClick={() => selectResource(r)}
                  className={`w-full text-left px-3 py-2 hover:bg-blue-50 text-sm border-b last:border-0 ${r.id === resourceId ? "bg-blue-50 font-medium" : ""}`}>
                  <div className="font-medium">{r.name}</div>
                  {r.description && <div className="text-xs text-gray-400 truncate">{r.description}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
