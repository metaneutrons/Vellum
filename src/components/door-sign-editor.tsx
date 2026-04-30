// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Rnd } from "react-rnd";
import { TEMPLATE_VARS, DEFAULT_DISPLAY, type TextBox, type Design, type DisplaySize } from "@/lib/content/renderers/door-sign-types";

export type { TextBox, Design, DisplaySize };

/* ── Types ────────────────────────────────────────────────────── */

interface Props {
  design: Design;
  designOverrides: Record<string, Design>;
  onChange: (design: Design, overrides: Record<string, Design>) => void;
  knownDisplays: DisplaySize[];
  providerId?: string;
  resourceId?: string;
  onPropertiesResolved?: (props: Record<string, string>) => void;
}

/* ── Component ────────────────────────────────────────────────── */

export function DoorSignEditor({ design, designOverrides, onChange, knownDisplays, providerId, resourceId, onPropertiesResolved }: Props) {
  const [activeDisplay, setActiveDisplay] = useState<string>("default");
  const [editingFree, setEditingFree] = useState(false);
  const [selectedBox, setSelectedBox] = useState<string | null>(null);
  const [dynamicVars, setDynamicVars] = useState<{ key: string; label: string }[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 600, h: 360 });

  const displays = knownDisplays.length > 0 ? knownDisplays : [DEFAULT_DISPLAY];

  const currentDisplay = activeDisplay === "default"
    ? displays[0]
    : displays.find(d => `${d.width}x${d.height}` === activeDisplay) ?? displays[0];

  const aspectRatio = currentDisplay.width / currentDisplay.height;

  const activeDesign = activeDisplay === "default"
    ? design
    : (designOverrides[activeDisplay] ?? design);

  const boxes = editingFree ? activeDesign.freeTextBoxes : activeDesign.textBoxes;

  // Resolve resource properties when provider/resource changes
  useEffect(() => {
    if (!providerId || !resourceId) return;
    fetch(`/api/v1/admin/resource-properties?providerId=${providerId}&resourceId=${resourceId}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((props: Record<string, string>) => {
        const vars = Object.keys(props).map(k => ({ key: `{${k}}`, label: k }));
        setDynamicVars(vars);
        if (onPropertiesResolved) onPropertiesResolved(props);
      })
      .catch((err) => {
        console.warn("Failed to load resource properties:", err);
        setDynamicVars([]);
      });
  }, [providerId, resourceId, onPropertiesResolved]);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setContainerSize({ w, h: w / aspectRatio });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [aspectRatio]);

  const updateDesign = useCallback((updated: Design) => {
    if (activeDisplay === "default") onChange(updated, designOverrides);
    else onChange(design, { ...designOverrides, [activeDisplay]: updated });
  }, [activeDisplay, design, designOverrides, onChange]);

  const updateBox = useCallback((id: string, patch: Partial<TextBox>) => {
    const key = editingFree ? "freeTextBoxes" : "textBoxes";
    updateDesign({ ...activeDesign, [key]: activeDesign[key].map(b => b.id === id ? { ...b, ...patch } : b) });
  }, [activeDesign, editingFree, updateDesign]);

  const addBox = useCallback(() => {
    const key = editingFree ? "freeTextBoxes" : "textBoxes";
    const newBox: TextBox = {
      id: crypto.randomUUID(),
      x: 0.2, y: 0.3, w: 0.6, h: 0.1,
      template: "{full_name}",
      fontSize: 0.06,
      align: "center",
      color: "#000000",
      bold: false,
    };
    updateDesign({ ...activeDesign, [key]: [...activeDesign[key], newBox] });
    setSelectedBox(newBox.id);
  }, [activeDesign, editingFree, updateDesign]);

  const deleteBox = useCallback((id: string) => {
    const key = editingFree ? "freeTextBoxes" : "textBoxes";
    updateDesign({ ...activeDesign, [key]: activeDesign[key].filter(b => b.id !== id) });
    if (selectedBox === id) setSelectedBox(null);
  }, [activeDesign, editingFree, selectedBox, updateDesign]);

  const handleBgUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("name", file.name);
    const res = await fetch("/api/v1/admin/assets", { method: "POST", body: form });
    if (res.ok) {
      const { id } = await res.json();
      updateDesign({ ...activeDesign, backgroundAssetId: id });
    }
  }, [activeDesign, updateDesign]);

  const createOverride = useCallback((key: string) => {
    onChange(design, { ...designOverrides, [key]: structuredClone(design) });
    setActiveDisplay(key);
  }, [design, designOverrides, onChange]);

  const removeOverride = useCallback((key: string) => {
    const { [key]: _, ...rest } = designOverrides;
    onChange(design, rest);
    setActiveDisplay("default");
  }, [design, designOverrides, onChange]);

  const selectedBoxData = boxes.find(b => b.id === selectedBox);
  const bgUrl = activeDesign.backgroundAssetId ? `/api/v1/admin/assets/${activeDesign.backgroundAssetId}` : null;
  const allVars = [...TEMPLATE_VARS, ...dynamicVars];

  return (
    <div className="space-y-4">
      {/* Display selector tabs */}
      <div className="flex items-center gap-2 border-b pb-2">
        <button
          onClick={() => setActiveDisplay("default")}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${activeDisplay === "default" ? "bg-black text-white dark:bg-white dark:text-black" : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200"}`}
        >
          Default
        </button>
        {displays.map(d => {
          const key = `${d.width}x${d.height}`;
          const hasOverride = key in designOverrides;
          return (
            <button
              key={key}
              onClick={() => hasOverride ? setActiveDisplay(key) : createOverride(key)}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors ${activeDisplay === key ? "bg-black text-white dark:bg-white dark:text-black" : hasOverride ? "bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800" : "bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 opacity-60"}`}
            >
              {d.label}
              {!hasOverride && <span className="ml-1 text-xs">+</span>}
            </button>
          );
        })}
        {activeDisplay !== "default" && activeDisplay in designOverrides && (
          <button onClick={() => removeOverride(activeDisplay)} className="text-xs text-red-500 hover:text-red-700 ml-2">
            Remove override
          </button>
        )}
      </div>

      {/* Occupied / Free toggle */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Editing:</span>
        <button onClick={() => setEditingFree(false)}
          className={`px-3 py-1 text-sm rounded-md ${!editingFree ? "bg-green-600 text-white" : "bg-gray-100 dark:bg-gray-800"}`}>
          Occupied
        </button>
        <button onClick={() => setEditingFree(true)}
          className={`px-3 py-1 text-sm rounded-md ${editingFree ? "bg-orange-500 text-white" : "bg-gray-100 dark:bg-gray-800"}`}>
          Free
        </button>
      </div>

      <div className="flex gap-4">
        {/* Canvas area */}
        <div className="flex-1 min-w-0" ref={containerRef}>
          <div
            className="relative border border-gray-300 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm"
            style={{ width: containerSize.w, height: containerSize.h, background: activeDesign.backgroundColor }}
            onClick={() => setSelectedBox(null)}
          >
            {bgUrl && (
              <img src={bgUrl} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
            )}
            {boxes.map(box => (
              <Rnd
                key={box.id}
                position={{ x: box.x * containerSize.w, y: box.y * containerSize.h }}
                size={{ width: box.w * containerSize.w, height: box.h * containerSize.h }}
                bounds="parent"
                onDragStop={(_e, d) => updateBox(box.id, { x: d.x / containerSize.w, y: d.y / containerSize.h })}
                onResizeStop={(_e, _dir, ref, _delta, pos) => updateBox(box.id, {
                  w: ref.offsetWidth / containerSize.w, h: ref.offsetHeight / containerSize.h,
                  x: pos.x / containerSize.w, y: pos.y / containerSize.h,
                })}
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); setSelectedBox(box.id); }}
                className={`cursor-move ${selectedBox === box.id ? "ring-2 ring-blue-500" : ""}`}
              >
                <div
                  className={`relative w-full h-full border border-dashed flex items-center justify-center overflow-hidden ${selectedBox === box.id ? "border-blue-500 bg-blue-50/30" : "border-gray-400/50 hover:border-blue-300"}`}
                  style={{ fontSize: `${box.fontSize * containerSize.h}px`, textAlign: box.align, color: box.color, fontWeight: box.bold ? "bold" : "normal" }}
                >
                  <span className="px-1 truncate">{box.template}</span>
                  {selectedBox === box.id && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteBox(box.id); }}
                      className="absolute top-1 right-1 w-6 h-6 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-md backdrop-blur-sm bg-white/60 dark:bg-black/40 flex items-center justify-center transition-colors"
                      title="Delete"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14M10 11v6M14 11v6"/>
                      </svg>
                    </button>
                  )}
                </div>
              </Rnd>
            ))}
          </div>
          <button onClick={addBox} className="mt-2 text-sm text-blue-600 hover:text-blue-800 font-medium">
            + Add text box
          </button>
        </div>

        {/* Properties panel */}
        <div className="w-64 shrink-0 space-y-3">
          {/* Background */}
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Background</label>
            <input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={handleBgUpload} className="text-xs w-full" />
            {activeDesign.backgroundAssetId && (
              <button onClick={() => updateDesign({ ...activeDesign, backgroundAssetId: null })} className="text-xs text-red-500 mt-1">Remove</button>
            )}
            <label className="block text-xs mt-2">Color</label>
            <input type="color" value={activeDesign.backgroundColor}
              onChange={e => updateDesign({ ...activeDesign, backgroundColor: e.target.value })}
              className="w-8 h-8 rounded border cursor-pointer" />
          </div>

          {/* Selected box properties */}
          {selectedBoxData && (
            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Text Box</label>
              <label className="block text-xs">Template</label>
              <textarea value={selectedBoxData.template}
                onChange={e => updateBox(selectedBoxData.id, { template: e.target.value })}
                className="w-full border rounded px-2 py-1 text-sm h-16 resize-none" placeholder="{full_name}" />
              <div className="flex flex-wrap gap-1">
                {allVars.map(v => (
                  <button key={v.key}
                    onClick={() => updateBox(selectedBoxData.id, { template: selectedBoxData.template + " " + v.key })}
                    className="text-[10px] px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200"
                    title={v.label}>{v.key}</button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs">Size</label>
                  <input type="range" min="0.02" max="0.2" step="0.005"
                    value={selectedBoxData.fontSize}
                    onChange={e => updateBox(selectedBoxData.id, { fontSize: parseFloat(e.target.value) })}
                    className="w-full" />
                  <span className="text-[10px] text-gray-500">{Math.round(selectedBoxData.fontSize * 100)}%</span>
                </div>
                <div>
                  <label className="block text-xs">Align</label>
                  <select value={selectedBoxData.align}
                    onChange={e => updateBox(selectedBoxData.id, { align: e.target.value as TextBox["align"] })}
                    className="w-full border rounded px-1 py-0.5 text-sm">
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div>
                  <label className="block text-xs">Color</label>
                  <input type="color" value={selectedBoxData.color}
                    onChange={e => updateBox(selectedBoxData.id, { color: e.target.value })}
                    className="w-8 h-8 rounded border cursor-pointer" />
                </div>
                <label className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="checkbox" checked={selectedBoxData.bold}
                    onChange={e => updateBox(selectedBoxData.id, { bold: e.target.checked })} />
                  Bold
                </label>
              </div>
              <button onClick={() => deleteBox(selectedBoxData.id)} className="text-xs text-red-500 hover:text-red-700">
                Delete text box
              </button>
            </div>
          )}

          {/* Multi-display preview */}
          <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Preview all sizes</label>
            <div className="space-y-2">
              {displays.map(d => {
                const key = `${d.width}x${d.height}`;
                const previewDesign = designOverrides[key] ?? design;
                const previewBoxes = editingFree ? previewDesign.freeTextBoxes : previewDesign.textBoxes;
                const pw = 220;
                const ph = pw / (d.width / d.height);
                const previewBg = previewDesign.backgroundAssetId ? `/api/v1/admin/assets/${previewDesign.backgroundAssetId}` : null;
                return (
                  <div key={key}>
                    <span className="text-[10px] text-gray-500">{d.label}</span>
                    <div className="relative border border-gray-200 dark:border-gray-700 rounded overflow-hidden"
                      style={{ width: pw, height: ph, background: previewDesign.backgroundColor }}>
                      {previewBg && <img src={previewBg} alt="" className="absolute inset-0 w-full h-full object-cover" />}
                      {previewBoxes.map(box => (
                        <div key={box.id}
                          className="absolute border border-dashed border-gray-400/40 flex items-center justify-center overflow-hidden"
                          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`,
                            fontSize: `${box.fontSize * ph}px`, textAlign: box.align, color: box.color, fontWeight: box.bold ? "bold" : "normal" }}>
                          <span className="truncate px-0.5">{box.template}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
