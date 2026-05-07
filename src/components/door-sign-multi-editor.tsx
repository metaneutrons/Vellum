// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

/**
 * Door-sign-multi editor — header TextBoxes + row template for multiple resources.
 */

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { TextBoxCanvas } from "@/components/text-box-canvas";
import { KNOWN_DISPLAYS, type DisplaySize, type TextBox, type Design } from "@/lib/content/renderers/door-sign-types";
import { MULTI_TEMPLATE_VARS, type DoorSignMultiConfig, type ResourceEntry, type RowTemplate } from "@/lib/content/renderers/door-sign-multi-types";

interface Provider { id: string; name: string; type: string; }

interface Props {
  config: DoorSignMultiConfig;
  onChange: (config: DoorSignMultiConfig) => void;
  providers: Provider[];
  knownDisplays?: DisplaySize[];
}

export function DoorSignMultiEditor({ config, onChange, providers, knownDisplays }: Props) {
  const t = useTranslations("content.doorSign");
  const [activeDisplay, setActiveDisplay] = useState<string>("default");
  const [availableResources, setAvailableResources] = useState<{ id: string; name: string }[]>([]);
  const [selectedProvider, setSelectedProvider] = useState(config.resources[0]?.providerId ?? providers[0]?.id ?? "");

  const displays = knownDisplays ?? KNOWN_DISPLAYS;
  const currentDisplay = activeDisplay === "default"
    ? displays[0]
    : displays.find(d => `${d.width}x${d.height}` === activeDisplay) ?? displays[0];

  // Fetch available resources when provider changes
  useEffect(() => {
    if (!selectedProvider) return;
    fetch(`/api/v1/admin/anny-resources?providerId=${selectedProvider}`)
      .then(r => r.ok ? r.json() : [])
      .then(setAvailableResources)
      .catch(() => setAvailableResources([]));
  }, [selectedProvider]);

  const toggleResource = useCallback((resourceId: string, resourceName: string) => {
    const exists = config.resources.find(r => r.resourceId === resourceId && r.providerId === selectedProvider);
    if (exists) {
      onChange({ ...config, resources: config.resources.filter(r => !(r.resourceId === resourceId && r.providerId === selectedProvider)) });
    } else {
      onChange({ ...config, resources: [...config.resources, { providerId: selectedProvider, resourceId, resourceName }] });
    }
  }, [config, onChange, selectedProvider]);

  const updateDesign = useCallback((design: Design) => {
    if (activeDisplay === "default") {
      onChange({ ...config, design });
    } else {
      onChange({ ...config, designOverrides: { ...config.designOverrides, [activeDisplay]: design } });
    }
  }, [config, onChange, activeDisplay]);

  const updateRowTemplate = useCallback((patch: Partial<RowTemplate>) => {
    onChange({ ...config, rowTemplate: { ...config.rowTemplate, ...patch } });
  }, [config, onChange]);

  const activeDesign = activeDisplay === "default"
    ? config.design
    : (config.designOverrides[activeDisplay] ?? config.design);

  const headerVars = [{ key: "{resource_count}", label: "Number of resources" }];
  const bgUrl = activeDesign.backgroundAssetId ? `/api/v1/admin/assets/${activeDesign.backgroundAssetId}` : null;

  return (
    <div className="space-y-4">
      {/* Resource selection */}
      <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg space-y-3">
        <label className="block text-sm font-semibold">Resources</label>
        <select value={selectedProvider} onChange={e => setSelectedProvider(e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm">
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="max-h-48 overflow-y-auto space-y-1">
          {availableResources.map(r => {
            const checked = config.resources.some(cr => cr.resourceId === r.id && cr.providerId === selectedProvider);
            return (
              <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 px-2 py-1 rounded">
                <input type="checkbox" checked={checked} onChange={() => toggleResource(r.id, r.name)} />
                {r.name}
              </label>
            );
          })}
          {availableResources.length === 0 && <span className="text-xs text-gray-500">Loading resources...</span>}
        </div>
        {config.resources.length > 0 && (
          <div className="text-xs text-gray-500">{config.resources.length} selected</div>
        )}
      </div>

      {/* Display selector */}
      <div className="flex items-center gap-2 border-b pb-2 flex-wrap">
        <button onClick={() => setActiveDisplay("default")}
          className={`px-3 py-1.5 text-sm rounded-md ${activeDisplay === "default" ? "bg-black text-white dark:bg-white dark:text-black" : "bg-gray-100 dark:bg-gray-800"}`}>
          Default
        </button>
        {displays.map(d => {
          const key = `${d.width}x${d.height}`;
          return (
            <button key={key} onClick={() => setActiveDisplay(key)}
              className={`px-3 py-1.5 text-sm rounded-md ${activeDisplay === key ? "bg-black text-white dark:bg-white dark:text-black" : "bg-gray-100 dark:bg-gray-800"}`}>
              {d.label}
            </button>
          );
        })}
      </div>

      {/* Header height slider */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Header</label>
        <input type="range" min="0.1" max="0.6" step="0.05" value={config.headerHeight}
          onChange={e => onChange({ ...config, headerHeight: parseFloat(e.target.value) })}
          className="flex-1" />
        <span className="text-xs text-gray-500">{Math.round(config.headerHeight * 100)}%</span>
      </div>

      {/* Header TextBox editor */}
      <TextBoxCanvas
        label="Header Area"
        boxes={activeDesign.textBoxes}
        onChange={boxes => updateDesign({ ...activeDesign, textBoxes: boxes })}
        width={currentDisplay.width}
        height={Math.round(currentDisplay.height * config.headerHeight)}
        backgroundColor={activeDesign.backgroundColor}
        backgroundUrl={bgUrl}
        templateVars={headerVars}
      />

      {/* Row template editor */}
      <TextBoxCanvas
        label="Row Template (repeated per resource)"
        boxes={config.rowTemplate.textBoxes}
        onChange={boxes => updateRowTemplate({ textBoxes: boxes })}
        width={currentDisplay.width}
        height={Math.round(currentDisplay.height * (1 - config.headerHeight) / Math.max(config.resources.length, 3))}
        backgroundColor={activeDesign.backgroundColor}
        templateVars={MULTI_TEMPLATE_VARS as unknown as { key: string; label: string }[]}
      />

      {/* Free row template */}
      <TextBoxCanvas
        label="Row Template (when free)"
        boxes={config.rowTemplate.freeTextBoxes}
        onChange={boxes => updateRowTemplate({ freeTextBoxes: boxes })}
        width={currentDisplay.width}
        height={Math.round(currentDisplay.height * (1 - config.headerHeight) / Math.max(config.resources.length, 3))}
        backgroundColor={activeDesign.backgroundColor}
        templateVars={MULTI_TEMPLATE_VARS as unknown as { key: string; label: string }[]}
      />

      {/* Preview */}
      <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
        <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Preview</label>
        <div className="relative border rounded overflow-hidden"
          style={{ width: "100%", maxWidth: 400, aspectRatio: `${currentDisplay.width}/${currentDisplay.height}`, background: activeDesign.backgroundColor }}>
          {bgUrl && <img src={bgUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />}
          {/* Header area indicator */}
          <div className="absolute left-0 right-0 top-0 border-b border-dashed border-blue-300"
            style={{ height: `${config.headerHeight * 100}%` }}>
            <span className="absolute top-1 left-2 text-[9px] text-blue-400">Header</span>
          </div>
          {/* Row indicators */}
          {config.resources.map((r, i) => (
            <div key={r.resourceId} className="absolute left-0 right-0 border-b border-dashed border-gray-300 flex items-center px-2"
              style={{
                top: `${(config.headerHeight + (1 - config.headerHeight) * i / config.resources.length) * 100}%`,
                height: `${(1 - config.headerHeight) / config.resources.length * 100}%`,
              }}>
              <span className="text-[9px] text-gray-400 truncate">{r.resourceName ?? r.resourceId}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
