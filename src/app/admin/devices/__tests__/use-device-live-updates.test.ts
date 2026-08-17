// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import { mergeDeviceRows, type LiveDeviceRow } from "../use-device-live-updates";

const row = (mac: string, value: number): LiveDeviceRow => ({ mac, value });

describe("mergeDeviceRows", () => {
  it("updates an existing card without moving it", () => {
    const current = [row("A", 1), row("B", 1), row("C", 1)];
    const merged = mergeDeviceRows(current, [row("B", 2)], new Set(["B"]));

    expect(merged.map((device) => device.mac)).toEqual(["A", "B", "C"]);
    expect(merged[1]).toEqual(row("B", 2));
  });

  it("places newly discovered devices before the stable card order", () => {
    const merged = mergeDeviceRows([row("A", 1), row("B", 1)], [row("C", 1)], new Set(["C"]));

    expect(merged.map((device) => device.mac)).toEqual(["C", "A", "B"]);
  });

  it("removes a deleted device from a targeted authoritative response", () => {
    const merged = mergeDeviceRows([row("A", 1), row("B", 1)], [], new Set(["B"]));

    expect(merged.map((device) => device.mac)).toEqual(["A"]);
  });

  it("treats a full snapshot as authoritative for every device", () => {
    const merged = mergeDeviceRows([row("A", 1), row("B", 1)], [row("B", 2)], null);

    expect(merged).toEqual([row("B", 2)]);
  });

  /* The path the hook takes when it adopts server-rendered props: a full list,
   * no requested subset. Assigning those props directly would be simpler but
   * would reorder the cards; this asserts the reassignment lands and the order
   * survives. Reported as: changing a device's content applied it in the database
   * but the dropdown snapped back until the page was reloaded. */
  it("adopts a reassignment from a full server-rendered list without reordering", () => {
    const assigned = (mac: string, contentInstanceId: string | null): LiveDeviceRow => ({
      mac,
      content_instance_id: contentInstanceId,
    });
    const current = [assigned("A", "old"), assigned("B", null), assigned("C", "keep")];

    const merged = mergeDeviceRows(
      current,
      [assigned("A", "new"), assigned("B", null), assigned("C", "keep")],
      null
    );

    expect(merged.map((device) => device.mac)).toEqual(["A", "B", "C"]);
    expect(merged[0].content_instance_id).toBe("new");
    expect(merged[2].content_instance_id).toBe("keep");
  });
});
