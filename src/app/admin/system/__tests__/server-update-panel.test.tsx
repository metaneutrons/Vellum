// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/components/toast";
import messages from "@/i18n/messages/en.json";
import type { ServerUpdateStatus } from "@/lib/server-updater";
import { readUpdateWindow } from "@/lib/update-window";
import { ServerUpdatePanel } from "../server-update-panel";

const system = messages.system;

const base: ServerUpdateStatus = {
  supported: true,
  availabilityReason: "ready",
  state: "current",
  currentVersion: "v1.23.2",
  availableVersion: null,
  updateAvailable: false,
  updateMode: "manual",
  maintenanceTime: "02:00",
  timezone: "UTC",
  lastCheckedAt: null,
  lastCheckAttemptAt: null,
  lastUpdatedAt: null,
  lastError: null,
  releaseCheckStatus: "ok",
  releaseCheckError: null,
  releaseCheckRetryAt: null,
  updaterVersion: "v1.23.2",
  updaterUpdateAvailable: false,
  updaterSelfUpdateCapable: true,
  updaterSelfUpdateEnabled: true,
  updaterSwap: null,
  progress: null,
  managedBy: null,
};

/** Answers to the panel's POST requests, consumed in order. */
let postResponses: Response[] = [];
let postRejection: Error | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function renderPanel(status: Partial<ServerUpdateStatus> = {}, canUpdate = true) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ToastProvider>
        <ServerUpdatePanel initialStatus={{ ...base, ...status }} canUpdate={canUpdate} />
      </ToastProvider>
    </NextIntlClientProvider>
  );
}

function lastPostBody(): unknown {
  const body = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : null;
}

const fetchMock = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
  /* The panel starts polling on mount. Leaving that GET unresolved keeps every
   * test looking at the status it rendered with, so the only thing that can
   * change the screen is the POST the test itself triggers. */
  if (init?.method !== "POST") return new Promise<Response>(() => {});
  if (postRejection) return Promise.reject(postRejection);
  const next = postResponses.shift();
  return next ? Promise.resolve(next) : Promise.reject(new Error("no response queued"));
});

beforeEach(() => {
  postResponses = [];
  postRejection = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("the server update panel under a platform that deploys the stack", () => {
  /* The controls have to be gone rather than disabled: a disabled button still
   * tells the operator that this is where the update happens, and under Coolify
   * it is not. */
  it("offers no controls and says where to update instead", () => {
    renderPanel({ managedBy: "coolify" });

    expect(screen.getByText(system.serverManagedByCoolify)).toBeDefined();
    expect(screen.queryByRole("button", { name: system.serverCheck })).toBeNull();
    expect(screen.queryByRole("button", { name: system.serverInstall })).toBeNull();
  });

  it("names the platform it recognised", () => {
    renderPanel({ managedBy: "coolify" });

    expect(screen.getByText(system.serverManagedByCoolify).getAttribute("data-managed-by")).toBe(
      "coolify"
    );
  });

  /* The refusal outranks every other state, so a platform-managed installation
   * that also has an update waiting still shows no way to install it. */
  it("keeps the refusal even when an update is available", () => {
    renderPanel({ managedBy: "coolify", updateAvailable: true, availableVersion: "v1.24.0" });

    expect(screen.getByText(system.serverManagedByCoolify)).toBeDefined();
    expect(screen.queryByRole("button", { name: system.serverInstall })).toBeNull();
  });

  // The counter-check: a plain Compose installation keeps its controls.
  it("leaves the controls in place when no platform is recognised", () => {
    renderPanel({ managedBy: null });

    expect(screen.getByRole("button", { name: system.serverCheck })).toBeDefined();
    expect(screen.queryByText(system.serverManagedByCoolify)).toBeNull();
  });
});

describe("the server update panel when the updater is not usable", () => {
  it("explains the one-time setup when no updater is configured", () => {
    renderPanel({ supported: false, availabilityReason: "not-configured" });

    expect(screen.getByText(system.serverUpdaterSetupTitle)).toBeDefined();
    expect(screen.getByText(system.serverUpdaterNotConfigured)).toBeDefined();
    expect(screen.getByRole("link", { name: system.serverUpdaterSetupLink })).toBeDefined();
    expect(screen.queryByRole("button", { name: system.serverCheck })).toBeNull();
  });

  it("points at the documentation when the updater answers with nonsense", () => {
    renderPanel({ supported: false, availabilityReason: "invalid-response" });

    expect(screen.getByText(system.serverUpdaterInvalidTitle)).toBeDefined();
    expect(screen.getByText(system.serverUpdaterInvalidHint)).toBeDefined();
    expect(screen.getByRole("link", { name: system.serverUpdaterSetupLink })).toBeDefined();
  });

  /* An unreachable updater is usually a restart in progress, so this state gets
   * no documentation link: there is nothing for the operator to fix. */
  it("reports a restart without sending the operator to the documentation", () => {
    renderPanel({ supported: false, availabilityReason: "unreachable" });

    expect(screen.getByText(system.serverUpdaterReconnectingTitle)).toBeDefined();
    expect(screen.getByText(system.serverUpdaterReconnectingHint)).toBeDefined();
    expect(screen.queryByRole("link", { name: system.serverUpdaterSetupLink })).toBeNull();
  });
});

describe("the server update panel reporting the state it is in", () => {
  it("raises an alert with the updater's own message after a failure", () => {
    renderPanel({ state: "failed", lastError: "image pull refused" });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(system.serverUpdateFailedGeneric);
    expect(alert.textContent).toContain("image pull refused");
  });

  it("offers a retry rather than an install after a failure", () => {
    renderPanel({ state: "failed", updateAvailable: true, availableVersion: "v1.24.0" });

    expect(
      screen.getAllByRole("button", { name: system.serverRetryUpdate }).length
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: system.serverInstall })).toBeNull();
  });

  it("says a release is still being published while it is preparing", () => {
    renderPanel({ state: "preparing", availableVersion: "v1.24.0" });

    expect(screen.getByText(/is still being published/)).toBeDefined();
  });

  it("names the daily window when updates install automatically", () => {
    renderPanel({ updateMode: "automatic", maintenanceTime: "03:30", timezone: "Europe/Berlin" });

    expect(
      screen.getByText(/New releases install daily at 03:30 \(Europe\/Berlin\)/)
    ).toBeDefined();
  });

  it("disables both controls while an update is running", () => {
    renderPanel({ state: "updating", updateAvailable: true, availableVersion: "v1.24.0" });

    expect(screen.getByRole("button", { name: system.serverCheck }).hasAttribute("disabled")).toBe(
      true
    );
    expect(
      screen.getByRole("button", { name: system.serverInstall }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("shows the check is running instead of inviting another one", () => {
    renderPanel({ state: "checking" });

    expect(
      screen.getByRole("button", { name: system.serverChecking }).hasAttribute("disabled")
    ).toBe(true);
  });

  /* A degraded release check must not look like a broken server: the installed
   * version is still known and correct, only the lookup of newer ones failed. */
  it("marks a degraded release check as delayed rather than failed", () => {
    renderPanel({ releaseCheckStatus: "degraded", releaseCheckError: "rate-limited" });

    expect(screen.getByText(system.serverStateCheckDelayed)).toBeDefined();
    expect(screen.getByText(system.serverReleaseCheckDelayedTitle)).toBeDefined();
    expect(screen.getByText(system.serverReleaseCheckRateLimited)).toBeDefined();
    expect(screen.getByText(system.serverReleaseCheckPreserved)).toBeDefined();
  });

  it("distinguishes an incomplete response from a rate limit", () => {
    renderPanel({ releaseCheckStatus: "degraded", releaseCheckError: "invalid-response" });

    expect(screen.getByText(system.serverReleaseCheckInvalid)).toBeDefined();
  });

  it("falls back to the general wording for any other check error", () => {
    renderPanel({ releaseCheckStatus: "degraded", releaseCheckError: "upstream-timeout" });

    expect(screen.getByText(system.serverReleaseCheckUnavailable)).toBeDefined();
  });

  /* A failed update is the louder problem, so it keeps the state pill. */
  it("lets a failure outrank a degraded release check", () => {
    renderPanel({ state: "failed", releaseCheckStatus: "degraded", releaseCheckError: null });

    expect(screen.getByText(system.serverStateFailed)).toBeDefined();
    expect(screen.queryByText(system.serverStateCheckDelayed)).toBeNull();
  });
});

describe("the server update panel reporting on the updater itself", () => {
  it("reports a self-update that was rolled back, with the updater's detail", () => {
    renderPanel({
      updaterSwap: { outcome: "rolled-back", detail: "health check failed", at: null },
    });

    expect(screen.getByText(system.updaterSwapRolledBack)).toBeDefined();
    expect(screen.getByText("health check failed")).toBeDefined();
  });

  it("reports a self-update that failed outright", () => {
    renderPanel({ updaterSwap: { outcome: "failed", detail: null, at: null } });

    expect(screen.getByText(system.updaterSwapFailed)).toBeDefined();
  });

  /* A succeeded swap is not news; reporting it would leave a permanent banner
   * on a healthy installation. */
  it("says nothing about a self-update that worked", () => {
    renderPanel({ updaterSwap: { outcome: "succeeded", detail: null, at: null } });

    expect(screen.queryByText(system.updaterSwapFailed)).toBeNull();
    expect(screen.queryByText(system.updaterSwapRolledBack)).toBeNull();
  });

  it("hands over the bootstrap commands when the updater cannot replace itself", () => {
    renderPanel({
      updaterUpdateAvailable: true,
      updaterVersion: "v1.23.0",
      availableVersion: "v1.24.0",
      updaterSelfUpdateCapable: false,
    });

    expect(screen.getByText(/The update service is still on v1\.23\.0/)).toBeDefined();
    expect(screen.getByText(system.updaterBootstrapHint)).toBeDefined();
    expect(screen.getByText(/docker compose pull updater/)).toBeDefined();
  });

  it("promises an automatic updater update when the updater can do it", () => {
    renderPanel({ updaterUpdateAvailable: true, availableVersion: "v1.24.0" });

    expect(screen.getByText(system.updaterAutomaticHint)).toBeDefined();
    expect(screen.queryByText(system.updaterBootstrapHint)).toBeNull();
  });

  it("says so when automatic updater updates are switched off", () => {
    renderPanel({ updaterUpdateAvailable: true, updaterSelfUpdateEnabled: false });

    expect(screen.getByText(system.updaterAutomaticDisabledHint)).toBeDefined();
  });

  /* No reported version means an updater from before version reporting, which
   * is outdated by definition even though nothing compared two versions. */
  it("treats a missing updater version as outdated", () => {
    renderPanel({ updaterVersion: null, updaterUpdateAvailable: false });

    expect(screen.getByText(system.updaterVersionUnknown)).toBeDefined();
  });
});

describe("the server update panel for a reader without permission", () => {
  it("shows the state but no way to act on it", () => {
    renderPanel({ updateAvailable: true, availableVersion: "v1.24.0" }, false);

    expect(screen.getByText("v1.23.2")).toBeDefined();
    expect(screen.queryByRole("button", { name: system.serverCheck })).toBeNull();
    expect(screen.queryByRole("button", { name: system.serverSaveSchedule })).toBeNull();
  });
});

describe("the server update panel running an action", () => {
  it("asks the updater to check and reports that it started", async () => {
    postResponses.push(jsonResponse({ ...base, state: "checking" }));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: system.serverCheck }));

    expect(await screen.findByText(system.serverCheckStarted)).toBeDefined();
    expect(lastPostBody()).toEqual({ action: "check" });
  });

  it("names a refused action rather than calling it a generic failure", async () => {
    postResponses.push(jsonResponse({ error: "forbidden" }, 403));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: system.serverCheck }));

    expect(await screen.findByText(system.serverActionForbidden)).toBeDefined();
  });

  it("names an unreachable updater rather than calling it a generic failure", async () => {
    postResponses.push(jsonResponse({ error: "unavailable" }, 503));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: system.serverCheck }));

    expect(await screen.findByText(system.serverUpdaterUnavailable)).toBeDefined();
  });

  it("falls back to the general failure for any other status", async () => {
    postResponses.push(jsonResponse({ error: "boom" }, 500));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: system.serverCheck }));

    expect(await screen.findByText(system.serverActionFailed)).toBeDefined();
  });

  it("survives a request that never reaches the server", async () => {
    postRejection = new Error("network down");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: system.serverCheck }));

    expect(await screen.findByText(system.serverActionFailed)).toBeDefined();
  });

  /* An error page or a proxy can answer 200 with something that is not a status.
   * Taking it as state would blank the panel, so it is dropped silently. */
  it("ignores a successful response that is not a status", async () => {
    postResponses.push(jsonResponse({ hello: "world" }));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: system.serverCheck }));

    /* Let the request settle before looking. Asserting while it is still in
     * flight would pass whether or not the response was rejected. */
    await act(async () => {});
    expect(lastPostBody()).toEqual({ action: "check" });
    expect(screen.queryByText(system.serverCheckStarted)).toBeNull();
    expect(screen.getByText("v1.23.2")).toBeDefined();
  });

  it("confirms before installing and opens the update window once accepted", async () => {
    postResponses.push(jsonResponse({ ...base, state: "updating", availableVersion: "v1.24.0" }));
    renderPanel({ updateAvailable: true, availableVersion: "v1.24.0" });

    fireEvent.click(screen.getByRole("button", { name: system.serverInstall }));
    const dialog = await screen.findByRole("dialog", { name: system.serverConfirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: system.serverInstall }));

    expect(await screen.findByText(system.serverUpdateStarted)).toBeDefined();
    expect(lastPostBody()).toEqual({ action: "apply" });
    expect(readUpdateWindow()?.toVersion).toBe("v1.24.0");
  });

  it("installs nothing when the confirmation is dismissed", async () => {
    renderPanel({ updateAvailable: true, availableVersion: "v1.24.0" });

    fireEvent.click(screen.getByRole("button", { name: system.serverInstall }));
    const dialog = await screen.findByRole("dialog", { name: system.serverConfirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});

describe("the server update panel saving the update schedule", () => {
  it("reveals the window fields only once automatic is chosen", () => {
    renderPanel();

    expect(screen.queryByLabelText(system.serverMaintenanceTime)).toBeNull();
    fireEvent.change(screen.getByLabelText(system.serverUpdateMode), {
      target: { value: "automatic" },
    });
    expect(screen.getByLabelText(system.serverMaintenanceTime)).toBeDefined();
    expect(screen.getByLabelText(system.serverTimezone)).toBeDefined();
  });

  /* Nothing to save until something changed, so the button starts out dead. */
  it("keeps the save button inert until the form is touched", () => {
    renderPanel();

    const save = screen.getByRole("button", { name: system.serverSaveSchedule });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(system.serverUpdateMode), {
      target: { value: "automatic" },
    });
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  it("refuses to save a window with no time in it", () => {
    renderPanel({ updateMode: "automatic" });

    fireEvent.change(screen.getByLabelText(system.serverMaintenanceTime), {
      target: { value: "" },
    });
    expect(
      screen.getByRole("button", { name: system.serverSaveSchedule }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("sends the whole schedule and reports that it was saved", async () => {
    postResponses.push(
      jsonResponse({ ...base, updateMode: "automatic", maintenanceTime: "04:15" })
    );
    renderPanel();

    fireEvent.change(screen.getByLabelText(system.serverUpdateMode), {
      target: { value: "automatic" },
    });
    fireEvent.change(screen.getByLabelText(system.serverMaintenanceTime), {
      target: { value: "04:15" },
    });
    fireEvent.change(screen.getByLabelText(system.serverTimezone), {
      target: { value: "Europe/Berlin" },
    });
    fireEvent.click(screen.getByRole("button", { name: system.serverSaveSchedule }));

    expect(await screen.findByText(system.serverScheduleSaved)).toBeDefined();
    expect(lastPostBody()).toEqual({
      action: "configure",
      mode: "automatic",
      maintenanceTime: "04:15",
      timezone: "Europe/Berlin",
    });
  });

  it("reports a schedule the server would not take", async () => {
    postResponses.push(jsonResponse({ error: "bad timezone" }, 400));
    renderPanel();

    fireEvent.change(screen.getByLabelText(system.serverUpdateMode), {
      target: { value: "automatic" },
    });
    fireEvent.click(screen.getByRole("button", { name: system.serverSaveSchedule }));

    expect(await screen.findByText(system.serverScheduleFailed)).toBeDefined();
  });

  it("reports a schedule request that never reached the server", async () => {
    postRejection = new Error("network down");
    renderPanel();

    fireEvent.change(screen.getByLabelText(system.serverUpdateMode), {
      target: { value: "automatic" },
    });
    fireEvent.click(screen.getByRole("button", { name: system.serverSaveSchedule }));

    expect(await screen.findByText(system.serverScheduleFailed)).toBeDefined();
  });
});
