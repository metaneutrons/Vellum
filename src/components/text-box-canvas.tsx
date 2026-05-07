// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

/**
 * Shared TextBox canvas editor — drag & drop text boxes on a canvas.
 * Used by door-sign, door-sign-multi, and future renderers.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Rnd } from "react-rnd";
import type { TextBox } from "@/lib/content/renderers/door-sign-types";

interface Props {
  boxes: TextBox[];
  onChange: (boxes: TextBox[]) => void;
  width: number;
  height: number;
  backgroundColor: string;
  backgroundUrl?: string | null;
  templateVars: { key: string; label: string }[];
  /** Optional: restrict canvas to a portion of the display (e.g. header only) */
  label?: string;
}

export function TextBoxCanvas({ boxes, onChange, width, height, backgroundColor, backgroundUrl, templateVars, label }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 500, h: 300 });
  const [selectedBox, setSelectedBox] = useState<string | null>(null);

  const aspectRatio = width / height;

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

  const updateBox = useCallback((id: string, patch: Partial<TextBox>) => {
    onChange(boxes.map(b => b.id === id ? { ...b, ...patch } : b));
  }, [boxes, onChange]);

  const addBox = useCallback(() => {
    const newBox: TextBox = {
      id: crypto.randomUUID(),
      x: 0.1, y: 0.2, w: 0.8, h: 0.15,
      template: "{full_name}",
      fontSize: 0.08,
      align: "center",
      color: "#000000",
      bold: false,
    };
    onChange([...boxes, newBox]);
    setSelectedBox(newBox.id);
  }, [boxes, onChange]);

  const deleteBox = useCallback((id: string) => {
    onChange(boxes.filter(b => b.id !== id));
    if (selectedBox === id) setSelectedBox(null);
  }, [boxes, onChange, selectedBox]);

  const selectedBoxData = boxes.find(b => b.id === selectedBox);

  return (
    <div className="space-y-2">
      {label && <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>}
      <div className="flex-1 min-w-0" ref={containerRef}>
        <div
          className="relative border border-gray-300 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm"
          style={{ width: containerSize.w, height: containerSize.h, background: backgroundColor }}
          onClick={() => setSelectedBox(null)}
        >
          {backgroundUrl && (
            <img src={backgroundUrl} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
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
                    onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); deleteBox(box.id); }}
                    className="absolute top-1 right-1 w-5 h-5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded bg-white/60 dark:bg-black/40 flex items-center justify-center"
                    title="Delete"
                  >×</button>
                )}
              </div>
            </Rnd>
          ))}
        </div>
        <button onClick={addBox} className="mt-2 text-sm text-blue-600 hover:text-blue-800 font-medium">
          + Add Text Box
        </button>
      </div>

      {/* Properties panel for selected box */}
      {selectedBoxData && (
        <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500">Text Box</label>
          <textarea value={selectedBoxData.template}
            onChange={e => updateBox(selectedBoxData.id, { template: e.target.value })}
            className="w-full border rounded px-2 py-1 text-sm h-12 resize-none" placeholder="{full_name}" />
          <div className="flex flex-wrap gap-1">
            {templateVars.map(v => (
              <button key={v.key}
                onClick={() => updateBox(selectedBoxData.id, { template: selectedBoxData.template + (selectedBoxData.template ? " " : "") + v.key })}
                className="text-[10px] px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded hover:bg-blue-200"
                title={v.label}>{v.key}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs">Size</label>
              <input type="range" min="0.02" max="0.3" step="0.005"
                value={selectedBoxData.fontSize}
                onChange={e => updateBox(selectedBoxData.id, { fontSize: parseFloat(e.target.value) })}
                className="w-full" />
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
            <input type="color" value={selectedBoxData.color}
              onChange={e => updateBox(selectedBoxData.id, { color: e.target.value })}
              className="w-8 h-8 rounded border cursor-pointer" />
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input type="checkbox" checked={selectedBoxData.bold}
                onChange={e => updateBox(selectedBoxData.id, { bold: e.target.checked })} />
              Bold
            </label>
            <button onClick={() => deleteBox(selectedBoxData.id)} className="ml-auto text-xs text-red-500 hover:text-red-700">Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}
