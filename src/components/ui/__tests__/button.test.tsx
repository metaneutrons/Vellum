// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../button";

describe("the button", () => {
  /* `type="button"` by default: a button inside a form that submits it by
   * accident is the kind of defect nobody reports, they just stop using it. */
  it("defaults to a plain button in the filled medium style", () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("bg-accent");
    expect(button.className).toContain("min-h-11");
  });

  it("takes a different variant and size", () => {
    render(
      <Button variant="destructive" size="sm">
        Delete
      </Button>
    );

    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.className).toContain("bg-red");
    expect(button.className).toContain("min-h-8");
  });

  it("keeps the caller's own classes alongside its own", () => {
    render(<Button className="w-full">Wide</Button>);

    expect(screen.getByRole("button", { name: "Wide" }).className).toContain("w-full");
  });

  it("submits when it is asked to", () => {
    render(<Button type="submit">Send</Button>);

    expect(screen.getByRole("button", { name: "Send" }).getAttribute("type")).toBe("submit");
  });

  it("passes a click through", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  /* Loading disables as well as announces: the request is already running, and
   * a second click would start another one. */
  it("announces and blocks while loading", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("leaves aria-busy off when it is not loading", () => {
    render(<Button>Idle</Button>);

    expect(screen.getByRole("button", { name: "Idle" }).hasAttribute("aria-busy")).toBe(false);
  });

  it("shows the adornments it was given", () => {
    render(
      <Button leading={<span data-testid="leading" />} trailing={<span data-testid="trailing" />}>
        Both
      </Button>
    );

    expect(screen.getByTestId("leading")).toBeDefined();
    expect(screen.getByTestId("trailing")).toBeDefined();
  });

  /* The spinner takes the leading slot, so showing both would make the button
   * jump wider at the moment it starts working. */
  it("replaces the adornments with the spinner while loading", () => {
    render(
      <Button
        loading
        leading={<span data-testid="leading" />}
        trailing={<span data-testid="trailing" />}
      >
        Busy
      </Button>
    );

    expect(screen.queryByTestId("leading")).toBeNull();
    expect(screen.queryByTestId("trailing")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Busy" }).querySelector(".animate-spin")
    ).toBeDefined();
  });

  it("stays disabled when it is told to be, loading or not", () => {
    render(<Button disabled>Off</Button>);

    expect(screen.getByRole("button", { name: "Off" }).hasAttribute("disabled")).toBe(true);
  });

  /* An icon-only button has no children, and wrapping nothing in a span would
   * leave an empty element the gap still spaces out. */
  it("renders no label wrapper when it has no children", () => {
    render(<Button aria-label="Close" leading={<span data-testid="icon" />} />);

    expect(screen.getByRole("button", { name: "Close" }).querySelector("span > span")).toBeNull();
  });

  it("forwards a ref to the underlying element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Focus me</Button>);

    expect(ref.current?.tagName).toBe("BUTTON");
  });
});
