// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";

interface Resource {
  id: string;
  name: string;
  description?: string;
  bookingUrl?: string;
}

interface Props {
  providerId: string;
  resourceId: string;
  resourceName?: string;
  onChange: (resourceId: string, resourceName: string, bookingUrl?: string) => void;
}

/**
 * Searchable resource picker, for any provider that can enumerate.
 *
 * Was anny-specific in both name and endpoint, which is why two of the three
 * places asking for a resource fell back to a raw identifier field. It now talks
 * to `/provider-resources` and the capability lives on the provider, so a
 * provider that gains enumeration needs no change here.
 *
 * When the provider cannot enumerate — an iCal feed, whose URL *is* its resource
 * — this shows a plain field for the identifier and says so, rather than an empty
 * search box that would look broken.
 */
export function ResourcePicker({ providerId, resourceId, resourceName, onChange }: Props) {
  const [supported, setSupported] = useState(true);
  const t = useTranslations("resourcePicker");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState(resourceName ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchResources = useCallback(
    async (q: string) => {
      if (!providerId) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({ providerId });
        if (q) params.set("search", q);
        const res = await fetch(`/api/v1/admin/provider-resources?${params}`);
        if (res.ok) {
          const body = (await res.json()) as { supported?: boolean; resources?: Resource[] };
          setSupported(body.supported !== false);
          setResults(body.resources ?? []);
        } else {
          setResults([]);
        }
      } catch {
        setResults([]);
      }
      setLoading(false);
    },
    [providerId]
  );

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchResources(search), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
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
    onChange(r.id, r.name, r.bookingUrl);
  }

  if (!supported) {
    return (
      <div>
        <input
          className="w-full min-h-11 px-3 rounded-md bg-surface-secondary border border-separator text-[15px] text-label placeholder:text-label-tertiary focus-ring"
          value={resourceId}
          onChange={(e) => onChange(e.target.value, e.target.value)}
          aria-label={t("identifier")}
        />
        <p className="mt-1 text-[12px] text-label-tertiary">{t("notListable")}</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      {resourceId && !open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            fetchResources("");
          }}
          className="w-full min-h-11 px-3 rounded-md bg-surface-secondary border border-separator text-[15px] text-label text-left focus-ring transition hover:bg-surface-hover flex justify-between items-center gap-2"
        >
          <span className="truncate">{selectedName || resourceId}</span>
          <span className="text-label-tertiary text-xs shrink-0 inline-flex items-center gap-1">
            <Pencil size={13} aria-hidden="true" />
            {t("change")}
          </span>
        </button>
      ) : (
        <input
          className="w-full min-h-11 px-3 rounded-md bg-surface-secondary border border-separator text-[15px] text-label placeholder:text-label-tertiary focus-ring"
          placeholder={t("search")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            if (!results.length) fetchResources("");
          }}
          aria-label={t("search")}
        />
      )}
      {open && (
        <div className="absolute z-50 w-full mt-1 bg-surface border border-separator rounded-lg shadow-e3 max-h-64 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-sm text-label-tertiary">{t("loading")}</div>}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-label-tertiary">
              {search ? t("noResults") : t("noResources")}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => select(r)}
              className={`w-full text-left px-3 py-2 hover:bg-surface-secondary focus-ring text-sm border-b border-separator last:border-0 ${r.id === resourceId ? "bg-accent-soft font-medium" : ""}`}
            >
              <div className="font-medium text-label">{r.name}</div>
              {r.description && (
                <div className="text-xs text-label-tertiary truncate">{r.description}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
