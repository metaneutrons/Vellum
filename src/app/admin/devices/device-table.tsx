"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { approveDevice, updateDevice, deleteDevice } from "../actions";
import { useToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

interface Device {
  mac: string;
  status: string;
  contentInstanceId: string | null;
  themeId: string | null;
  refreshProfileId: string | null;
  lastSeen: Date | null;
  displayCaps: unknown;
}

interface Props {
  devices: Device[];
  themes: { id: string; name: string }[];
  contentInstances: { id: string; name: string }[];
  refreshProfiles: { id: string; name: string }[];
}

type SortKey = "mac" | "status" | "lastSeen";
type SortDir = "asc" | "desc";
const STATUSES = ["all", "pending", "approved", "rejected"] as const;

export function DeviceTable({ devices, themes, contentInstances, refreshProfiles }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("lastSeen");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return devices
      .filter(d => statusFilter === "all" || d.status === statusFilter)
      .filter(d => !q || d.mac.toLowerCase().includes(q) ||
        ((d.displayCaps as { model?: string })?.model ?? "").toLowerCase().includes(q))
      .sort((a, b) => {
        let cmp = 0;
        if (sortKey === "mac") cmp = a.mac.localeCompare(b.mac);
        else if (sortKey === "status") cmp = a.status.localeCompare(b.status);
        else cmp = (a.lastSeen?.getTime() ?? 0) - (b.lastSeen?.getTime() ?? 0);
        return sortDir === "desc" ? -cmp : cmp;
      });
  }, [devices, search, statusFilter, sortKey, sortDir]);

  function act(fn: () => Promise<void>, ok: string, fail: string) {
    startTransition(async () => { try { await fn(); toast("success", ok); } catch { toast("error", fail); } });
  }

  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <>
      <PageHeader title="Devices" description="Manage registered E-Ink displays"
        actions={<span className="text-xs text-gray-500">{filtered.length} device{filtered.length !== 1 ? "s" : ""}</span>} />

      <div className="flex gap-3 mb-4 items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search MAC or model..." />
        <div className="flex gap-1">
          {STATUSES.map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs rounded-full border ${statusFilter === s ? "bg-gray-900 text-white border-gray-900" : "hover:bg-gray-100"}`}>
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
      </div>

      <div className={`bg-white rounded-lg shadow overflow-hidden ${pending ? "opacity-60 pointer-events-none" : ""}`}>
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort("mac")}>MAC{sortIcon("mac")}</th>
              <th className="px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort("status")}>Status{sortIcon("status")}</th>
              <th className="px-4 py-3 font-medium">Display</th>
              <th className="px-4 py-3 font-medium">Content</th>
              <th className="px-4 py-3 font-medium">Theme</th>
              <th className="px-4 py-3 font-medium">Profile</th>
              <th className="px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort("lastSeen")}>Last Seen{sortIcon("lastSeen")}</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map(d => {
              const caps = d.displayCaps as { model?: string } | null;
              return (
                <tr key={d.mac} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/admin/devices/${d.mac}`} className="text-blue-600 hover:underline">{d.mac}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      d.status === "approved" ? "bg-green-100 text-green-800" :
                      d.status === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                    }`}>{d.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{caps?.model ?? "—"}</td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Content" value={d.contentInstanceId ?? ""}
                      onChange={e => act(() => updateDevice(d.mac, { contentInstanceId: e.target.value || null }), "Updated", "Failed")}>
                      <option value="">—</option>
                      {contentInstances.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Theme" value={d.themeId ?? ""}
                      onChange={e => act(() => updateDevice(d.mac, { themeId: e.target.value || null }), "Updated", "Failed")}>
                      <option value="">default</option>
                      {themes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Profile" value={d.refreshProfileId ?? ""}
                      onChange={e => act(() => updateDevice(d.mac, { refreshProfileId: e.target.value || null }), "Updated", "Failed")}>
                      <option value="">default</option>
                      {refreshProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {d.lastSeen ? new Date(d.lastSeen).toLocaleString("de-DE") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {d.status === "pending" && <Button size="sm" onClick={() => act(() => approveDevice(d.mac), `${d.mac} approved`, "Failed")}>Approve</Button>}
                      <Button size="sm" variant="danger" onClick={() => setDeleting(d.mac)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <EmptyState
            icon={devices.length === 0 ? "📡" : "🔍"}
            title={devices.length === 0 ? "No devices registered" : "No devices match your search"}
            description={devices.length === 0 ? "Devices register automatically when they first connect to the server." : undefined}
          />
        )}
      </div>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)}
        onConfirm={() => { const mac = deleting ?? ""; setDeleting(null); act(() => deleteDevice(mac), `${mac} deleted`, "Failed"); }}
        title="Delete Device" message={`Delete device ${deleting}? This permanently removes all telemetry and reports.`}
        confirmLabel="Delete" destructive />
    </>
  );
}
