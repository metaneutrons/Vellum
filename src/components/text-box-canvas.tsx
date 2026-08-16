// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

/**
 * Shared TextBox canvas editor — drag & drop text boxes on a canvas.
 * Used by door-sign, door-sign-multi, and future renderers.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { Rnd } from "react-rnd";
import { useTranslations } from "next-intl";
import { Plus, Trash2, X } from "lucide-react";
import type { TextBox } from "@/lib/content/renderers/door-sign-types";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

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

export function TextBoxCanvas({
  boxes,
  onChange,
  width,
  height,
  backgroundColor,
  backgroundUrl,
  templateVars,
  label,
}: Props) {
  const t = useTranslations("content.doorSign");
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

  const updateBox = useCallback(
    (id: string, patch: Partial<TextBox>) => {
      onChange(boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    },
    [boxes, onChange]
  );

  const addBox = useCallback(() => {
    const newBox: TextBox = {
      id: crypto.randomUUID(),
      x: 0.1,
      y: 0.2,
      w: 0.8,
      h: 0.15,
      template: "{full_name}",
      fontSize: 0.08,
      align: "center",
      color: "#000000",
      bold: false,
    };
    onChange([...boxes, newBox]);
    setSelectedBox(newBox.id);
  }, [boxes, onChange]);

  const deleteBox = useCallback(
    (id: string) => {
      onChange(boxes.filter((b) => b.id !== id));
      if (selectedBox === id) setSelectedBox(null);
    },
    [boxes, onChange, selectedBox]
  );

  const selectedBoxData = boxes.find((b) => b.id === selectedBox);

  return (
    <div className="space-y-2">
      {label && (
        <span className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">
          {label}
        </span>
      )}
      <div className="flex-1 min-w-0" ref={containerRef}>
        <div
          className="relative border border-separator rounded-lg overflow-hidden shadow-e1"
          style={{ width: containerSize.w, height: containerSize.h, background: backgroundColor }}
          onClick={() => setSelectedBox(null)}
        >
          {backgroundUrl && (
            <img
              src={backgroundUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            />
          )}
          {boxes.map((box) => (
            <Rnd
              key={box.id}
              position={{ x: box.x * containerSize.w, y: box.y * containerSize.h }}
              size={{ width: box.w * containerSize.w, height: box.h * containerSize.h }}
              bounds="parent"
              onDragStop={(_e, d) =>
                updateBox(box.id, { x: d.x / containerSize.w, y: d.y / containerSize.h })
              }
              onResizeStop={(_e, _dir, ref, _delta, pos) =>
                updateBox(box.id, {
                  w: ref.offsetWidth / containerSize.w,
                  h: ref.offsetHeight / containerSize.h,
                  x: pos.x / containerSize.w,
                  y: pos.y / containerSize.h,
                })
              }
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                setSelectedBox(box.id);
              }}
              className={`cursor-move ${selectedBox === box.id ? "ring-2 ring-accent" : ""}`}
            >
              <div
                className={`relative w-full h-full border border-dashed flex items-center justify-center overflow-hidden ${selectedBox === box.id ? "border-accent bg-accent-soft" : "border-separator hover:border-accent"}`}
                style={{
                  fontSize: `${box.fontSize * containerSize.h}px`,
                  textAlign: box.align,
                  color: box.color,
                  fontWeight: box.bold ? "bold" : "normal",
                }}
              >
                <span className="px-1 truncate">{box.template}</span>
                {selectedBox === box.id && (
                  <button
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      deleteBox(box.id);
                    }}
                    className="absolute top-1 right-1 size-5 text-label-tertiary hover:text-label rounded bg-surface/60 backdrop-blur-sm flex items-center justify-center focus-ring"
                    title={t("deleteTextBox")}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
            </Rnd>
          ))}
        </div>
        <button
          onClick={addBox}
          className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline font-medium focus-ring rounded"
        >
          <Plus size={14} aria-hidden="true" /> Add Text Box
        </button>
      </div>

      {/* Properties panel for selected box */}
      {selectedBoxData && (
        <div className="p-3 bg-surface-secondary rounded-lg space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary">
            {t("textBox")}
          </label>
          <textarea
            value={selectedBoxData.template}
            onChange={(e) => updateBox(selectedBoxData.id, { template: e.target.value })}
            className="w-full rounded-md bg-surface border border-separator px-2 py-1 text-sm text-label placeholder:text-label-tertiary h-12 resize-none focus-ring"
            placeholder="{full_name}"
          />
          <div className="flex flex-wrap gap-1">
            {templateVars.map((v) => (
              <button
                key={v.key}
                onClick={() =>
                  updateBox(selectedBoxData.id, {
                    template:
                      selectedBoxData.template + (selectedBoxData.template ? " " : "") + v.key,
                  })
                }
                className="text-[10px] px-1.5 py-0.5 bg-accent-soft text-accent rounded hover:opacity-80 focus-ring"
                title={v.label}
              >
                {v.key}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-label-secondary">{t("size")}</label>
              <input
                type="range"
                min="0.02"
                max="0.3"
                step="0.005"
                value={selectedBoxData.fontSize}
                onChange={(e) =>
                  updateBox(selectedBoxData.id, { fontSize: parseFloat(e.target.value) })
                }
                className="w-full accent-accent focus-ring"
              />
            </div>
            <div>
              <label className="block text-xs text-label-secondary">{t("align")}</label>
              <select
                value={selectedBoxData.align}
                onChange={(e) =>
                  updateBox(selectedBoxData.id, { align: e.target.value as TextBox["align"] })
                }
                className={`w-full ${selectCls}`}
              >
                <option value="left">{t("alignLeft")}</option>
                <option value="center">{t("alignCenter")}</option>
                <option value="right">{t("alignRight")}</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={selectedBoxData.color}
              onChange={(e) => updateBox(selectedBoxData.id, { color: e.target.value })}
              className="size-8 rounded-md border border-separator cursor-pointer focus-ring"
            />
            <label className="flex items-center gap-1 text-sm text-label cursor-pointer">
              <input
                type="checkbox"
                checked={selectedBoxData.bold}
                onChange={(e) => updateBox(selectedBoxData.id, { bold: e.target.checked })}
                className="accent-accent focus-ring"
              />
              Bold
            </label>
            <button
              onClick={() => deleteBox(selectedBoxData.id)}
              className="ml-auto inline-flex items-center gap-1 text-xs text-red hover:underline focus-ring rounded"
            >
              <Trash2 size={12} aria-hidden="true" /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
