"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { approveDevice, updateDevice, deleteDevice } from "../actions";
import { useToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";

interface Device {
  mac: string;
  status: "pending" | "approved" | "rejected";
  contentInstanceId: string | null;
  themeId: string | null;
  lastSeen: Date | null;
  displayCaps: unknown;
}

interface Props {
  devices: Device[];
  themes: { id: string; name: string }[];
  contentInstances: { id: string; name: string }[];
}

type SortKey = "mac" | "status" | "lastSeen";
type SortDir = "asc" | "desc";

const STATUSES = ["all", "pending", "approved", "rejected"] as const;

export function DeviceTable({ devices, themes, contentInstances }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("lastSeen");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return devices
      .filter((d) => statusFilter === "all" || d.status === statusFilter)
      .filter((d) => !q || d.mac.toLowerCase().includes(q) ||
        ((d.displayCaps as { model?: string })?.model ?? "").toLowerCase().includes(q))
      .sort((a, b) => {
        let cmp = 0;
        if (sortKey === "mac") cmp = a.mac.localeCompare(b.mac);
        else if (sortKey === "status") cmp = a.status.localeCompare(b.status);
        else if (sortKey === "lastSeen") cmp = (a.lastSeen?.getTime() ?? 0) - (b.lastSeen?.getTime() ?? 0);
        return sortDir === "desc" ? -cmp : cmp;
      });
  }, [devices, search, statusFilter, sortKey, sortDir]);

  function handleApprove(mac: string) {
    startTransition(async () => {
      try { await approveDevice(mac); toast("success", `Device ${mac} approved`); }
      catch { toast("error", "Failed to approve"); }
    });
  }

  function handleUpdate(mac: string, data: { contentInstanceId?: string | null; themeId?: string | null }) {
    startTransition(async () => {
      try { await updateDevice(mac, data); toast("success", "Device updated"); }
      catch { toast("error", "Failed to update"); }
    });
  }

  function handleDelete() {
    if (!deleting) return;
    const mac = deleting; setDeleting(null);
    startTransition(async () => {
      try { await deleteDevice(mac); toast("success", `Device ${mac} deleted`); }
      catch { toast("error", "Failed to delete"); }
    });
  }

  const sortIcon = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <>
      <div className="flex gap-3 mb-4 items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search MAC or model..." />
        <div className="flex gap-1">
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs rounded-full border ${
                statusFilter === s ? "bg-gray-900 text-white border-gray-900" : "hover:bg-gray-100"
              }`}>
              {s === "all" ? "All" : s}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400 ml-auto">{filtered.length} device{filtered.length !== 1 ? "s" : ""}</span>
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
              <th className="px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort("lastSeen")}>Last Seen{sortIcon("lastSeen")}</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((d) => {
              const caps = d.displayCaps as { model?: string } | null;
              return (
                <tr key={d.mac} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs"><Link href={`/admin/devices/${d.mac}`} className="text-blue-600 hover:underline">{d.mac}</Link></td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      d.status === "approved" ? "bg-green-100 text-green-800" :
                      d.status === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                    }`}>{d.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{caps?.model ?? "—"}</td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" value={d.contentInstanceId ?? ""}
                      onChange={(e) => handleUpdate(d.mac, { contentInstanceId: e.target.value || null })}>
                      <option value="">— none —</option>
                      {contentInstances.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" value={d.themeId ?? ""}
                      onChange={(e) => handleUpdate(d.mac, { themeId: e.target.value || null })}>
                      <option value="">— default —</option>
                      {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {d.lastSeen ? new Date(d.lastSeen).toLocaleString("de-DE") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {d.status === "pending" && <Button size="sm" onClick={() => handleApprove(d.mac)}>Approve</Button>}
                      <Button size="sm" variant="danger" onClick={() => setDeleting(d.mac)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  {devices.length === 0
                    ? <><p className="mb-1">No devices registered yet.</p><p className="text-xs">Devices register automatically when they first connect.</p></>
                    : <p>No devices match your search.</p>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={handleDelete}
        title="Delete Device" message={`Delete device ${deleting}? This permanently removes all telemetry and reports.`}
        confirmLabel="Delete" destructive />
    </>
  );
}
