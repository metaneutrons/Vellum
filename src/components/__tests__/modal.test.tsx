// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../modal";

function renderModal(onClose = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ common: { close: "Close" } }}>
      <button>Before</button>
      <Modal open onClose={onClose} title="Policy editor">
        <button>First</button>
        <button>Last</button>
      </Modal>
    </NextIntlClientProvider>
  );
  return onClose;
}

describe("Modal accessibility", () => {
  it("labels the dialog, locks page scrolling and closes with Escape", () => {
    const onClose = renderModal();
    expect(screen.getByRole("dialog", { name: "Policy editor" })).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus inside the dialog", () => {
    renderModal();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });
});
