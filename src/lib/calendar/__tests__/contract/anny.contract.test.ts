// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * anny speaks JSON:API. Bookings carry the times and a relationship to a customer,
 * and the customer's given and family names arrive in `included`.
 *
 * The double does NOT filter the window, because anny does not: its provider asks
 * for every page of a resource's bookings and filters them itself.
 */

import { vi } from "vitest";
import { annyProvider } from "../../providers/anny";
import { describeProviderContract, type WireEvent } from "./contract";

const ORG = "org-1";

function customerOf(e: WireEvent) {
  const [given, ...rest] = (e.organizerName ?? "").split(" ");
  return {
    id: `cust-${e.id}`,
    type: "customers",
    attributes: { given_name: given ?? "", family_name: rest.join(" ") },
  };
}

function bookingOf(e: WireEvent) {
  return {
    id: e.id,
    type: "bookings",
    attributes: {
      start_date: e.start,
      end_date: e.end,
      status: "accepted",
      description: e.subject,
    },
    relationships: e.organizerName ? { customer: { data: { id: `cust-${e.id}` } } } : undefined,
  };
}

function serve(events: WireEvent[]): void {
  const body = JSON.stringify({
    data: events.map(bookingOf),
    included: events.filter((e) => e.organizerName).map(customerOf),
    meta: { page: { "current-page": 1, "last-page": 1 } },
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    /* The provider resolves its organization from the token before it asks for
     * bookings. */
    if (url.includes("/organizations") || url.includes("/me")) {
      return new Response(JSON.stringify({ data: [{ id: ORG, type: "organizations" }] }), {
        status: 200,
        headers: { "content-type": "application/vnd.api+json" },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/vnd.api+json" },
    });
  });
}

describeProviderContract("anny", {
  provider: annyProvider,
  credentials: { apiToken: "test-token", organizationId: ORG },
  roomConfig: { resourceId: "173420", resourceName: "Besprechungsraum" },
  serve,
  cannot: {
    private:
      "anny has no privacy flag on a booking; its provider sets isPrivate to false " +
      "unconditionally, and a room's policy is what hides a subject here",
  },
});
