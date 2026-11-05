// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../toast";

function Raiser({ type, message }: { type: "success" | "error" | "info"; message: string }) {
  const { toast } = useToast();
  return <button onClick={() => toast(type, message)}>raise {message}</button>;
}

function raise(message: string) {
  fireEvent.click(screen.getByRole("button", { name: `raise ${message}` }));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the toast provider", () => {
  it("renders what it wraps and starts with nothing to announce", () => {
    render(
      <ToastProvider>
        <p>page content</p>
      </ToastProvider>
    );

    expect(screen.getByText("page content")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  /* The region is polite and permanent rather than created per message, so a
   * screen reader announces a toast that appears after the page settled. */
  it("announces messages through one polite live region", () => {
    render(
      <ToastProvider>
        <Raiser type="success" message="saved" />
      </ToastProvider>
    );

    raise("saved");

    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toContain("saved");
  });

  it("keeps several messages at once, in the order they were raised", () => {
    render(
      <ToastProvider>
        <Raiser type="info" message="first" />
        <Raiser type="error" message="second" />
      </ToastProvider>
    );

    raise("first");
    raise("second");

    const text = screen.getByRole("status").textContent;
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });

  it("grounds each kind in its own token colour", () => {
    render(
      <ToastProvider>
        <Raiser type="success" message="ok" />
        <Raiser type="error" message="broken" />
        <Raiser type="info" message="noted" />
      </ToastProvider>
    );

    raise("ok");
    raise("broken");
    raise("noted");

    const classes = within(screen.getByRole("status"))
      .getAllByText(/^(ok|broken|noted)$/)
      .map((node) => node.parentElement?.className ?? "");
    expect(classes[0]).toContain("bg-green");
    expect(classes[1]).toContain("bg-red");
    expect(classes[2]).toContain("bg-label");
  });

  it("clears a message on its own after three seconds", () => {
    render(
      <ToastProvider>
        <Raiser type="info" message="transient" />
      </ToastProvider>
    );

    raise("transient");
    expect(screen.getByRole("status").textContent).toContain("transient");

    act(() => void vi.advanceTimersByTime(3_000));

    expect(screen.getByRole("status").textContent).not.toContain("transient");
  });

  /* Dismissing one must not take the others with it, which is why the toast
   * carries an id rather than an index into the list. */
  it("dismisses only the message whose button was pressed", () => {
    render(
      <ToastProvider>
        <Raiser type="info" message="keep" />
        <Raiser type="error" message="drop" />
      </ToastProvider>
    );

    raise("keep");
    raise("drop");

    const region = screen.getByRole("status");
    const drop = within(region).getByText("drop").parentElement;
    fireEvent.click(within(drop as HTMLElement).getByRole("button"));

    expect(region.textContent).toContain("keep");
    expect(region.textContent).not.toContain("drop");
  });
});

describe("useToast without a provider", () => {
  /* Dropping the message is the deliberate default: a component that can be
   * mounted outside the provider should not crash for want of a toast. */
  it("accepts a message and does nothing with it", () => {
    render(<Raiser type="error" message="nowhere" />);

    expect(() => raise("nowhere")).not.toThrow();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
