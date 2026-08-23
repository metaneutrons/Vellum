import { describe, it, expect } from "vitest";
import { flattenAnnyResources } from "../providers/anny";

/**
 * anny models a flex office as a parent resource with one child per desk, each a
 * first-class resource with its own id and its own bookings. The shapes below
 * mirror what the live API returns for "S1 3er Flexbüro Sylt (1J.2.24)".
 *
 * The reason this matters: the flat resource list returns PARENTS ONLY, so a
 * picker built on it cannot reach a single seat — and a name plate for a
 * three-desk door then has no way to name its three occupants.
 */
const room = (id: string, name: string, children: string[] = [], archived = false) => ({
  id,
  type: "resources",
  attributes: { name, slug: name.toLowerCase().replace(/\W+/g, "-"), archived },
  relationships: { children: { data: children.map((c) => ({ id: c })) } },
});

const seat = (id: string, name: string, archived = false) => ({
  id,
  type: "resources",
  attributes: { name, archived },
});

describe("flattenAnnyResources", () => {
  it("puts each seat directly after its room", () => {
    const out = flattenAnnyResources(
      [room("179665", "S1 3er Flexbüro Sylt (1J.2.24)", ["179666", "179667", "179668"])],
      [seat("179666", "Sylt 1"), seat("179667", "Sylt2"), seat("179668", "Sylt 3")]
    );
    expect(out.map((r) => r.name)).toEqual([
      "S1 3er Flexbüro Sylt (1J.2.24)",
      "Sylt 1",
      "Sylt2",
      "Sylt 3",
    ]);
  });

  /* The room stays selectable: booking the whole flex office is a real thing, and
   * only the name plate wants the individual desks. */
  it("keeps the room itself selectable", () => {
    const out = flattenAnnyResources([room("1", "Room", ["2"])], [seat("2", "Desk")]);
    expect(out[0].id).toBe("1");
    expect(out[0].parentId).toBeUndefined();
  });

  /* Without the parent's name a flat list of "Sylt 1, Föhr 2, Amrum 1" is
   * unreadable, so a caller can indent and label without holding a tree. */
  it("tells a seat which room it belongs to", () => {
    const out = flattenAnnyResources(
      [room("179665", "S1 3er Flexbüro Sylt (1J.2.24)", ["179666"])],
      [seat("179666", "Sylt 1")]
    );
    expect(out[1]).toMatchObject({
      id: "179666",
      parentId: "179665",
      parentName: "S1 3er Flexbüro Sylt (1J.2.24)",
    });
  });

  it("leaves a room without children as a single entry", () => {
    const out = flattenAnnyResources([room("173420", "Besprechungsraum 1J.2.17")], []);
    expect(out).toHaveLength(1);
    expect(out[0].parentId).toBeUndefined();
  });

  /* An archived resource is still returned by the API. Offering one would set up
   * a display that can never show a booking. */
  it("drops an archived room and everything under it", () => {
    const out = flattenAnnyResources(
      [room("1", "Old room", ["2"], true), room("3", "Live room")],
      [seat("2", "Old desk")]
    );
    expect(out.map((r) => r.id)).toEqual(["3"]);
  });

  it("drops an archived seat but keeps its room", () => {
    const out = flattenAnnyResources(
      [room("1", "Room", ["2", "3"])],
      [seat("2", "Gone", true), seat("3", "Here")]
    );
    expect(out.map((r) => r.name)).toEqual(["Room", "Here"]);
  });

  /* A child referenced but absent from `included` must not become a hole in the
   * list. This is exactly what happened when `children` was missing from
   * `fields[resources]`: the relationship was empty and every seat vanished, with
   * a 200 and no error. */
  it("skips a child the response did not include", () => {
    const out = flattenAnnyResources([room("1", "Room", ["2", "3"])], [seat("3", "Present")]);
    expect(out.map((r) => r.name)).toEqual(["Room", "Present"]);
  });

  /* `included` carries other types too in JSON:API; only resources are seats. */
  it("ignores included entries that are not resources", () => {
    const out = flattenAnnyResources(
      [room("1", "Room", ["2"])],
      [{ id: "2", type: "customers", attributes: { name: "Someone" } }]
    );
    expect(out.map((r) => r.name)).toEqual(["Room"]);
  });

  /* The booking link comes from anny's slug and is never inferred from a name,
   * because a resource id and its public slug are unrelated. */
  it("builds a booking url only from a slug the provider supplied", () => {
    const [withSlug] = flattenAnnyResources([room("1", "Room A")], []);
    expect(withSlug.bookingUrl).toBe("https://anny.co/b/book/room-a");

    const [withoutSlug] = flattenAnnyResources(
      [{ id: "1", type: "resources", attributes: { name: "Room A" } }],
      []
    );
    expect(withoutSlug.bookingUrl).toBeUndefined();
  });
});
