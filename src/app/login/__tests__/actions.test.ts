import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  redirect: vi.fn(),
  authenticateLocalUser: vi.fn(),
  createUserSession: vi.fn(),
  checkLimit: vi.fn(() => ({ allowed: true })),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "user-agent": "vitest" })),
  cookies: () => Promise.resolve({ set: mocks.cookieSet }),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/rate-limit", () => ({
  loginLimiter: { check: mocks.checkLimit },
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/access", () => ({
  authenticateLocalUser: mocks.authenticateLocalUser,
  createUserSession: mocks.createUserSession,
}));
vi.mock("@/lib/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/env", () => ({ env: { NODE_ENV: "test" } }));

const { loginAction } = await import("@/app/login/actions");

function form(fields: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("loginAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkLimit.mockReturnValue({ allowed: true });
    mocks.createUserSession.mockResolvedValue("session-token");
    mocks.authenticateLocalUser.mockResolvedValue({ id: "u1", displayName: "Fabian" });
  });

  it("signs in and sets the session cookie", async () => {
    await loginAction(null, form({ user: "  fabian@example.org  ", pass: "correct horse" }));

    expect(mocks.authenticateLocalUser).toHaveBeenCalledWith("fabian@example.org", "correct horse");
    expect(mocks.cookieSet).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith("/admin");
  });

  /* The password used to be read with `formData.get("pass") as string`. A
   * multipart request may send a file part under that name, and the assertion
   * claimed it was text — so a File object travelled on towards the password
   * check instead of being refused here. */
  it("refuses a file sent as the password without attempting to authenticate", async () => {
    const result = await loginAction(
      null,
      form({ user: "fabian@example.org", pass: new File(["secret"], "pass.txt") })
    );

    expect(result).toEqual({ error: "Invalid credentials" });
    expect(mocks.authenticateLocalUser).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("refuses a file sent as the identity", async () => {
    const result = await loginAction(
      null,
      form({ user: new File(["fabian"], "user.txt"), pass: "correct horse" })
    );

    expect(result).toEqual({ error: "Invalid credentials" });
    expect(mocks.authenticateLocalUser).not.toHaveBeenCalled();
  });

  it("refuses an identity that is only whitespace", async () => {
    const result = await loginAction(null, form({ user: "   ", pass: "correct horse" }));

    expect(result).toEqual({ error: "Invalid credentials" });
    expect(mocks.authenticateLocalUser).not.toHaveBeenCalled();
  });

  it("refuses missing fields", async () => {
    expect(await loginAction(null, form({}))).toEqual({ error: "Invalid credentials" });
    expect(mocks.authenticateLocalUser).not.toHaveBeenCalled();
  });

  it("reports wrong credentials without setting a cookie", async () => {
    mocks.authenticateLocalUser.mockResolvedValue(null);

    const result = await loginAction(null, form({ user: "fabian@example.org", pass: "wrong" }));

    expect(result).toEqual({ error: "Invalid credentials" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  /* The limiter runs before the credentials are even read, so a blocked caller
   * cannot use the login form to probe whether an account exists. */
  it("stops at the rate limit before touching the credentials", async () => {
    mocks.checkLimit.mockReturnValue({ allowed: false });

    const result = await loginAction(null, form({ user: "fabian@example.org", pass: "correct" }));

    expect(result).toEqual({ error: "Too many attempts. Try again later." });
    expect(mocks.authenticateLocalUser).not.toHaveBeenCalled();
  });
});
