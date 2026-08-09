// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Microsoft Entra single-tenant OIDC using Authorization Code + PKCE. */
import "server-only";

import crypto from "node:crypto";
import * as oidc from "openid-client";
import { and, eq } from "drizzle-orm";
import { db, withDb } from "@/db";
import { adminUsers, auditLogs, oidcIdentities, userRoleAssignments } from "@/db/schema";
import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { SYSTEM_ROLES, createUserSession } from "@/lib/access";

const TX_COOKIE = "vellum_oidc_transaction";
const TX_TTL_SECONDS = 10 * 60;
const ENTRA_CALLBACK_PATH = "/api/auth/oidc/entra/callback";
let discovered: Promise<oidc.Configuration> | undefined;

type Transaction = { state: string; nonce: string; verifier: string; expiresAt: number };
export type EntraIdentity = { issuer: string; subject: string; tenantId: string; email: string; displayName: string; groups: string[] };

export function isEntraConfigured(): boolean {
  return !!(env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID && env.ENTRA_CLIENT_SECRET && env.VELLUM_PUBLIC_URL);
}

/** Canonical callback URL; the path is fixed so it cannot drift in deployment config. */
export function entraRedirectUri(): string {
  if (!env.VELLUM_PUBLIC_URL) throw new Error("VELLUM_PUBLIC_URL is required for Microsoft Entra OIDC");
  return new URL(ENTRA_CALLBACK_PATH, env.VELLUM_PUBLIC_URL).href;
}

function config() {
  if (!isEntraConfigured()) throw new Error("Microsoft Entra OIDC is not configured");
  if (!discovered) {
    const issuer = new URL(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`);
    discovered = oidc.discovery(issuer, env.ENTRA_CLIENT_ID!, {
      client_secret: env.ENTRA_CLIENT_SECRET!,
      redirect_uris: [entraRedirectUri()],
      response_types: ["code"],
    });
  }
  return discovered;
}

function transactionSignature(payload: string): string {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET ?? "").update(payload).digest("base64url");
}

function encodeTransaction(tx: Transaction): string {
  const payload = Buffer.from(JSON.stringify(tx)).toString("base64url");
  return `${payload}.${transactionSignature(payload)}`;
}

function decodeTransaction(value: string | undefined): Transaction | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  const received = value.slice(dot + 1);
  const expected = transactionSignature(payload);
  if (received.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
  try {
    const tx = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Transaction;
    return typeof tx.state === "string" && typeof tx.nonce === "string" && typeof tx.verifier === "string" && tx.expiresAt > Date.now() ? tx : null;
  } catch { return null; }
}

export async function beginEntraLogin(): Promise<{ url: string; transaction: string }> {
  const oidcConfig = await config();
  const verifier = oidc.randomPKCECodeVerifier();
  const tx: Transaction = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier, expiresAt: Date.now() + TX_TTL_SECONDS * 1000 };
  const url = oidc.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: entraRedirectUri(), scope: "openid profile email", response_type: "code",
    state: tx.state, nonce: tx.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
  });
  return { url: url.href, transaction: encodeTransaction(tx) };
}

export function oidcTransactionCookieOptions() {
  return { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, maxAge: TX_TTL_SECONDS, path: "/api/auth/oidc/entra" };
}

export async function completeEntraLogin(currentUrl: URL, transactionCookie: string | undefined): Promise<EntraIdentity | null> {
  const tx = decodeTransaction(transactionCookie);
  if (!tx) return null;
  const tokens = await oidc.authorizationCodeGrant(await config(), currentUrl, { expectedState: tx.state, expectedNonce: tx.nonce, pkceCodeVerifier: tx.verifier });
  const claims = tokens.claims();
  if (!claims) return null;
  const tenantId = typeof claims.tid === "string" ? claims.tid : "";
  const subject = typeof claims.oid === "string" ? claims.oid : (typeof claims.sub === "string" ? claims.sub : "");
  const emailClaim = typeof claims.email === "string" ? claims.email : (typeof claims.preferred_username === "string" ? claims.preferred_username : "");
  const verified = claims.email_verified !== false;
  if (tenantId !== env.ENTRA_TENANT_ID || !subject || !emailClaim || !verified) return null;
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  const displayName = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : emailClaim;
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === "string") : [];
  return { issuer, subject, tenantId, email: emailClaim.trim().toLowerCase(), displayName, groups };
}

/** Links only a signed identity from the configured tenant; email is never a credential. */
export async function resolveEntraUser(identity: EntraIdentity): Promise<{ id: string; displayName: string } | null> {
  const [known] = await withDb(() => db.select({ userId: oidcIdentities.userId, displayName: adminUsers.displayName, status: adminUsers.status })
    .from(oidcIdentities).innerJoin(adminUsers, eq(oidcIdentities.userId, adminUsers.id))
    .where(and(eq(oidcIdentities.issuer, identity.issuer), eq(oidcIdentities.subject, identity.subject))).limit(1), "entra-known-identity");
  if (known) {
    if (known.status !== "active") return null;
    await withDb(() => db.update(oidcIdentities).set({ lastLoginAt: new Date(), email: identity.email }).where(and(eq(oidcIdentities.issuer, identity.issuer), eq(oidcIdentities.subject, identity.subject))), "entra-identity-login");
    return { id: known.userId, displayName: known.displayName };
  }
  const autoProvision = await getSetting("access.oidcAutoProvision");
  const [matchingUser] = await withDb(() => db.select().from(adminUsers).where(eq(adminUsers.email, identity.email)).limit(1), "entra-email-link");
  if (matchingUser?.status === "suspended" || (!matchingUser && !autoProvision)) return null;
  const defaultRole = await getSetting("access.oidcDefaultRole");
  const groupRoleMap = await getSetting("access.oidcGroupRoleMap");
  const mappedRole = identity.groups.map((group) => groupRoleMap[group]).find((role) => typeof role === "string");
  const roleId = (mappedRole ?? defaultRole) as string;
  if (!SYSTEM_ROLES.some((role) => role.id === roleId && role.id !== "owner")) return null;
  return withDb(() => db.transaction(async (tx) => {
    let user = matchingUser;
    if (!user) {
      const [created] = await tx.insert(adminUsers).values({ email: identity.email, displayName: identity.displayName }).returning();
      user = created;
      await tx.insert(userRoleAssignments).values({ userId: user.id, roleId });
    }
    await tx.insert(oidcIdentities).values({ userId: user.id, issuer: identity.issuer, subject: identity.subject, tenantId: identity.tenantId, email: identity.email });
    await tx.insert(auditLogs).values({ actorType: "user", actorId: user.id, action: matchingUser ? "access.oidc.link" : "access.oidc.provision", targetType: "user", targetId: user.id, metadata: { tenantId: identity.tenantId, roleId: matchingUser ? undefined : roleId } });
    return { id: user.id, displayName: user.displayName };
  }), "entra-resolve-user");
}

export { TX_COOKIE };
