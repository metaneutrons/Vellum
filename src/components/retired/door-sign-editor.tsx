// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { z } from "zod";
import { Rnd } from "react-rnd";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import {
  TEMPLATE_VARS,
  DEFAULT_DISPLAY,
  type TextBox,
  type Design,
  type DisplaySize,
} from "@/lib/content/retired/door-sign-types";

export type { TextBox, Design, DisplaySize };

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

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

export function DoorSignEditor({
  design,
  designOverrides,
  onChange,
  knownDisplays,
  providerId,
  resourceId,
  onPropertiesResolved,
}: Props) {
  const t = useTranslations("content.doorSign");
  const [activeDisplay, setActiveDisplay] = useState<string>("default");
  const [editingFree, setEditingFree] = useState(false);
  const [selectedBox, setSelectedBox] = useState<string | null>(null);
  const [dynamicVars, setDynamicVars] = useState<{ key: string; label: string }[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 600, h: 360 });

  const displays = knownDisplays.length > 0 ? knownDisplays : [DEFAULT_DISPLAY];

  const currentDisplay =
    activeDisplay === "default"
      ? (displays[0] ?? DEFAULT_DISPLAY)
      : (displays.find((d) => `${d.width}x${d.height}` === activeDisplay) ??
        displays[0] ??
        DEFAULT_DISPLAY);

  const aspectRatio = currentDisplay.width / currentDisplay.height;

  const activeDesign =
    activeDisplay === "default" ? design : (designOverrides[activeDisplay] ?? design);

  const boxes = editingFree ? activeDesign.freeTextBoxes : activeDesign.textBoxes;

  // Resolve resource properties when provider/resource changes
  useEffect(() => {
    if (!providerId || !resourceId) return;
    fetch(`/api/v1/admin/resource-properties?providerId=${providerId}&resourceId=${resourceId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((props: Record<string, string>) => {
        const vars = Object.keys(props).map((k) => ({ key: `{${k}}`, label: k }));
        setDynamicVars(vars);
        if (onPropertiesResolved) onPropertiesResolved(props);
      })
      .catch((err: unknown) => {
        console.error("Failed to load resource properties:", err);
        setDynamicVars([]);
      });
  }, [providerId, resourceId, onPropertiesResolved]);

  // Measure container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const w = entry.contentRect.width;
      setContainerSize({ w, h: w / aspectRatio });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [aspectRatio]);

  const updateDesign = useCallback(
    (updated: Design) => {
      if (activeDisplay === "default") onChange(updated, designOverrides);
      else onChange(design, { ...designOverrides, [activeDisplay]: updated });
    },
    [activeDisplay, design, designOverrides, onChange]
  );

  const updateBox = useCallback(
    (id: string, patch: Partial<TextBox>) => {
      const key = editingFree ? "freeTextBoxes" : "textBoxes";
      updateDesign({
        ...activeDesign,
        [key]: activeDesign[key].map((b) => (b.id === id ? { ...b, ...patch } : b)),
      });
    },
    [activeDesign, editingFree, updateDesign]
  );

  const addBox = useCallback(() => {
    const key = editingFree ? "freeTextBoxes" : "textBoxes";
    const newBox: TextBox = {
      id: crypto.randomUUID(),
      x: 0.2,
      y: 0.3,
      w: 0.6,
      h: 0.1,
      template: "{full_name}",
      fontSize: 0.06,
      align: "center",
      color: "#000000",
      bold: false,
    };
    updateDesign({ ...activeDesign, [key]: [...activeDesign[key], newBox] });
    setSelectedBox(newBox.id);
  }, [activeDesign, editingFree, updateDesign]);

  const deleteBox = useCallback(
    (id: string) => {
      const key = editingFree ? "freeTextBoxes" : "textBoxes";
      updateDesign({ ...activeDesign, [key]: activeDesign[key].filter((b) => b.id !== id) });
      if (selectedBox === id) setSelectedBox(null);
    },
    [activeDesign, editingFree, selectedBox, updateDesign]
  );

  const handleBgUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file);
      form.append("name", file.name);
      const res = await fetch("/api/v1/admin/assets", { method: "POST", body: form });
      if (res.ok) {
        const uploaded = z.object({ id: z.string() }).safeParse(await res.json());
        if (uploaded.success) {
          updateDesign({ ...activeDesign, backgroundAssetId: uploaded.data.id });
        }
      }
    },
    [activeDesign, updateDesign]
  );

  const createOverride = useCallback(
    (key: string) => {
      onChange(design, { ...designOverrides, [key]: structuredClone(design) });
      setActiveDisplay(key);
    },
    [design, designOverrides, onChange]
  );

  const removeOverride = useCallback(
    (key: string) => {
      const { [key]: _, ...rest } = designOverrides;
      onChange(design, rest);
      setActiveDisplay("default");
    },
    [design, designOverrides, onChange]
  );

  const selectedBoxData = boxes.find((b) => b.id === selectedBox);
  const bgUrl = activeDesign.backgroundAssetId
    ? `/api/v1/admin/assets/${activeDesign.backgroundAssetId}`
    : null;
  const allVars = [...TEMPLATE_VARS, ...dynamicVars];

  return (
    <div className="space-y-4">
      {/* Display selector tabs */}
      <div className="flex items-center gap-2 border-b border-separator pb-2">
        <button
          onClick={() => setActiveDisplay("default")}
          className={`px-3 py-1.5 text-sm rounded-md transition focus-ring ${activeDisplay === "default" ? "bg-accent text-on-accent" : "bg-fill-tertiary text-label hover:bg-fill-secondary"}`}
        >
          {t("default")}
        </button>
        {displays.map((d) => {
          const key = `${d.width}x${d.height}`;
          const hasOverride = key in designOverrides;
          return (
            <button
              key={key}
              onClick={() => (hasOverride ? setActiveDisplay(key) : createOverride(key))}
              className={`px-3 py-1.5 text-sm rounded-md transition focus-ring ${activeDisplay === key ? "bg-accent text-on-accent" : hasOverride ? "bg-accent-soft text-accent" : "bg-fill-tertiary text-label hover:bg-fill-secondary opacity-60"}`}
            >
              {d.label}
              {!hasOverride && <span className="ml-1 text-xs">+</span>}
            </button>
          );
        })}
        {activeDisplay !== "default" && activeDisplay in designOverrides && (
          <button
            onClick={() => removeOverride(activeDisplay)}
            className="text-xs text-red hover:underline ml-2 focus-ring rounded"
          >
            {t("removeOverride")}
          </button>
        )}
      </div>

      {/* Occupied / Free toggle */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-label">{t("editing")}:</span>
        <button
          onClick={() => setEditingFree(false)}
          className={`px-3 py-1 text-sm rounded-md transition focus-ring ${!editingFree ? "bg-green/15 text-green font-medium" : "bg-fill-tertiary text-label hover:bg-fill-secondary"}`}
        >
          {t("occupied")}
        </button>
        <button
          onClick={() => setEditingFree(true)}
          className={`px-3 py-1 text-sm rounded-md transition focus-ring ${editingFree ? "bg-orange/15 text-orange font-medium" : "bg-fill-tertiary text-label hover:bg-fill-secondary"}`}
        >
          {t("free")}
        </button>
      </div>

      <div className="flex gap-4">
        {/* Canvas area */}
        <div className="flex-1 min-w-0" ref={containerRef}>
          <div
            className="relative border border-separator rounded-lg overflow-hidden shadow-e1"
            style={{
              width: containerSize.w,
              height: containerSize.h,
              background: activeDesign.backgroundColor,
            }}
            onClick={() => setSelectedBox(null)}
          >
            {bgUrl && (
              <img
                src={bgUrl}
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
                      className="absolute top-1 right-1 size-6 text-label-tertiary hover:text-label rounded-md backdrop-blur-sm bg-surface/60 flex items-center justify-center transition focus-ring"
                      title={t("deleteTextBox")}
                    >
                      <Trash2 size={14} aria-hidden="true" />
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
            <Plus size={14} aria-hidden="true" /> {t("addTextBox")}
          </button>
        </div>

        {/* Properties panel */}
        <div className="w-64 shrink-0 space-y-3">
          {/* Background */}
          <div className="p-3 bg-surface-secondary rounded-lg">
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">
              {t("background")}
            </label>
            <input
              type="file"
              accept="image/png,image/svg+xml,image/jpeg"
              onChange={(e) => void handleBgUpload(e)}
              className="text-xs w-full text-label-secondary file:mr-2 file:rounded-md file:border-0 file:bg-fill-tertiary file:px-2 file:py-1 file:text-label hover:file:bg-fill-secondary focus-ring rounded"
            />
            {activeDesign.backgroundAssetId && (
              <button
                onClick={() => updateDesign({ ...activeDesign, backgroundAssetId: null })}
                className="text-xs text-red hover:underline mt-1 focus-ring rounded"
              >
                {t("remove")}
              </button>
            )}
            <label className="block text-xs mt-2 text-label-secondary">{t("color")}</label>
            <input
              type="color"
              value={activeDesign.backgroundColor}
              onChange={(e) => updateDesign({ ...activeDesign, backgroundColor: e.target.value })}
              className="size-8 rounded-md border border-separator cursor-pointer focus-ring"
            />
          </div>

          {/* Selected box properties */}
          {selectedBoxData && (
            <div className="p-3 bg-surface-secondary rounded-lg space-y-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary">
                {t("textBox")}
              </label>
              <label className="block text-xs text-label-secondary">{t("template")}</label>
              <textarea
                value={selectedBoxData.template}
                onChange={(e) => updateBox(selectedBoxData.id, { template: e.target.value })}
                className="w-full rounded-md bg-surface border border-separator px-2 py-1 text-sm text-label placeholder:text-label-tertiary h-16 resize-none focus-ring"
                placeholder="{full_name}"
              />
              <div className="flex flex-wrap gap-1">
                {allVars.map((v) => (
                  <button
                    key={v.key}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      const current = boxes.find((b) => b.id === selectedBox);
                      if (current)
                        updateBox(current.id, {
                          template: current.template + (current.template ? " " : "") + v.key,
                        });
                    }}
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
                    max="0.2"
                    step="0.005"
                    value={selectedBoxData.fontSize}
                    onChange={(e) =>
                      updateBox(selectedBoxData.id, { fontSize: parseFloat(e.target.value) })
                    }
                    className="w-full accent-accent focus-ring"
                  />
                  <span className="text-[10px] text-label-tertiary">
                    {Math.round(selectedBoxData.fontSize * 100)}%
                  </span>
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
                <div>
                  <label className="block text-xs text-label-secondary">{t("color")}</label>
                  <input
                    type="color"
                    value={selectedBoxData.color}
                    onChange={(e) => updateBox(selectedBoxData.id, { color: e.target.value })}
                    className="size-8 rounded-md border border-separator cursor-pointer focus-ring"
                  />
                </div>
                <label className="flex items-center gap-1 text-sm text-label cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedBoxData.bold}
                    onChange={(e) => updateBox(selectedBoxData.id, { bold: e.target.checked })}
                    className="accent-accent focus-ring"
                  />
                  {t("bold")}
                </label>
              </div>
              <button
                onClick={() => deleteBox(selectedBoxData.id)}
                className="inline-flex items-center gap-1 text-xs text-red hover:underline focus-ring rounded"
              >
                <Trash2 size={12} aria-hidden="true" /> {t("deleteTextBox")}
              </button>
            </div>
          )}

          {/* Multi-display preview */}
          <div className="p-3 bg-surface-secondary rounded-lg">
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">
              {t("previewAllSizes")}
            </label>
            <div className="space-y-2">
              {displays.map((d) => {
                const key = `${d.width}x${d.height}`;
                const previewDesign = designOverrides[key] ?? design;
                const previewBoxes = editingFree
                  ? previewDesign.freeTextBoxes
                  : previewDesign.textBoxes;
                const pw = 220;
                const ph = pw / (d.width / d.height);
                const previewBg = previewDesign.backgroundAssetId
                  ? `/api/v1/admin/assets/${previewDesign.backgroundAssetId}`
                  : null;
                return (
                  <div key={key}>
                    <span className="text-[10px] text-label-tertiary">{d.label}</span>
                    <div
                      className="relative border border-separator rounded overflow-hidden"
                      style={{ width: pw, height: ph, background: previewDesign.backgroundColor }}
                    >
                      {previewBg && (
                        <img
                          src={previewBg}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                      )}
                      {previewBoxes.map((box) => (
                        <div
                          key={box.id}
                          className="absolute border border-dashed border-separator flex items-center justify-center overflow-hidden"
                          style={{
                            left: `${box.x * 100}%`,
                            top: `${box.y * 100}%`,
                            width: `${box.w * 100}%`,
                            height: `${box.h * 100}%`,
                            fontSize: `${box.fontSize * ph}px`,
                            textAlign: box.align,
                            color: box.color,
                            fontWeight: box.bold ? "bold" : "normal",
                          }}
                        >
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
