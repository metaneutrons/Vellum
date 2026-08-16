// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Central authorization boundary for the Console.
 *
 * UI visibility is merely a convenience; every server action and admin route
 * must call this module before reading or mutating protected state. Tokens are
 * opaque/revocable in the database and permissions are evaluated from role
 * assignments at request time, so disabling a person takes effect immediately.
 */
import "server-only";

import crypto from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, withDbRead, withDbTransaction, withDbWrite, type DbTransaction } from "@/db";
import {
  accessRoles,
  adminInvitations,
  adminSessions,
  adminUsers,
  auditLogs,
  rolePermissions,
  serviceAccountPermissions,
  serviceAccounts,
  userRoleAssignments,
} from "@/db/schema";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import {
  SESSION_COOKIE,
  createSessionToken,
  getSessionTokenSubject,
  safeEqualSecret,
} from "@/lib/session";
import { PERMISSIONS, type Permission } from "./permissions";
export { PERMISSIONS, type Permission } from "./permissions";
export type Scope = { type?: "workspace" | "site" | "fleet" | "device"; id?: string | null };

type SystemRole = {
  id: string;
  name: string;
  description: string;
  permissions: readonly (Permission | "*")[];
};
export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    id: "owner",
    name: "Owner",
    description: "Full ownership, including access and security.",
    permissions: ["*"],
  },
  {
    id: "administrator",
    name: "Administrator",
    description: "Runs Vellum without changing ownership.",
    permissions: PERMISSIONS.filter((p) => !p.startsWith("access.") && p !== "audit.read"),
  },
  {
    id: "fleet_operator",
    name: "Fleet Operator",
    description: "Manages devices and provisioning.",
    permissions: [
      "dashboard.read",
      "devices.read",
      "devices.manage",
      "devices.approve",
      "devices.provision",
      "firmware.read",
      "firmware.flash",
    ],
  },
  {
    id: "content_manager",
    name: "Content Manager",
    description: "Manages content, themes, profiles, and provider configuration without secrets.",
    permissions: [
      "dashboard.read",
      "content.read",
      "content.manage",
      "themes.manage",
      "profiles.manage",
      "providers.read",
    ],
  },
  {
    id: "firmware_operator",
    name: "Firmware Operator",
    description: "Flashes displays and manages staged rollouts.",
    permissions: [
      "dashboard.read",
      "devices.read",
      "firmware.read",
      "firmware.flash",
      "firmware.rollout",
    ],
  },
  {
    id: "auditor",
    name: "Auditor",
    description: "Read-only visibility into fleet configuration and audit history.",
    permissions: [
      "dashboard.read",
      "devices.read",
      "content.read",
      "providers.read",
      "firmware.read",
      "access.read",
      "audit.read",
      "system.read",
    ],
  },
  {
    id: "viewer",
    name: "Viewer",
    description: "Read-only fleet and content visibility.",
    permissions: [
      "dashboard.read",
      "devices.read",
      "content.read",
      "providers.read",
      "firmware.read",
      "system.read",
    ],
  },
] as const;

export type Principal = {
  type: "user" | "service_account" | "bootstrap";
  id: string;
  displayName: string;
  permissions: { permission: string; scopeType: string; scopeId: string | null }[];
};

export type AuditEvent = {
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  outcome?: "success" | "failure";
};

export class AuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "AuthorizationError";
  }
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

/** scrypt is a memory-hard KDF available in Node without a native module. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = crypto.scryptSync(password, salt, 64, {
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$32768$${salt}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string | null): boolean {
  if (!encoded) return false;
  const [algorithm, work, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !work || !salt || !expected) return false;
  try {
    const actual = crypto.scryptSync(password, salt, 64, {
      N: Number(work),
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
    const expectedBytes = Buffer.from(expected, "base64url");
    return expectedBytes.length === actual.length && crypto.timingSafeEqual(expectedBytes, actual);
  } catch {
    return false;
  }
}

export async function seedAccessControl(): Promise<void> {
  await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        for (const role of SYSTEM_ROLES) {
          await tx
            .insert(accessRoles)
            .values({ id: role.id, name: role.name, description: role.description, isSystem: true })
            .onConflictDoUpdate({
              target: accessRoles.id,
              set: {
                name: role.name,
                description: role.description,
                isSystem: true,
                updatedAt: new Date(),
              },
            });
          for (const permission of role.permissions) {
            await tx
              .insert(rolePermissions)
              .values({ roleId: role.id, permission })
              .onConflictDoNothing();
          }
        }
      }),
    "seed-access-control"
  );
}

async function permissionRowsForUser(userId: string) {
  return withDbRead(
    () =>
      db
        .select({
          permission: rolePermissions.permission,
          scopeType: userRoleAssignments.scopeType,
          scopeId: userRoleAssignments.scopeId,
        })
        .from(userRoleAssignments)
        .innerJoin(rolePermissions, eq(userRoleAssignments.roleId, rolePermissions.roleId))
        .where(eq(userRoleAssignments.userId, userId)),
    "access-user-permissions"
  );
}

function isAllowed(principal: Principal, permission: Permission, scope: Scope = {}): boolean {
  const requestedType = scope.type ?? "workspace";
  const requestedId = scope.id ?? null;
  return principal.permissions.some((grant) => {
    if (grant.permission !== "*" && grant.permission !== permission) return false;
    if (grant.scopeType === "workspace") return true;
    return grant.scopeType === requestedType && grant.scopeId === requestedId;
  });
}

export function hasPermission(
  principal: Principal | null,
  permission: Permission,
  scope: Scope = {}
): boolean {
  return !!principal && isAllowed(principal, permission, scope);
}

async function principalFromSessionToken(
  token: string | undefined | null
): Promise<Principal | null> {
  const sessionId = await getSessionTokenSubject(token);
  if (!sessionId || sessionId === "admin") return null; // invalidate pre-RBAC stateless sessions
  if (!token) return null;
  const tokenHash = digest(token);
  const [row] = await withDbRead(
    () =>
      db
        .select({ id: adminUsers.id, displayName: adminUsers.displayName })
        .from(adminSessions)
        .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
        .where(
          and(
            eq(adminSessions.id, sessionId),
            eq(adminSessions.tokenHash, tokenHash),
            eq(adminUsers.status, "active"),
            isNull(adminSessions.revokedAt),
            gt(adminSessions.expiresAt, new Date())
          )
        )
        .limit(1),
    "access-session-principal"
  );
  if (!row) return null;
  const permissions = await permissionRowsForUser(row.id);
  return { type: "user", id: row.id, displayName: row.displayName, permissions };
}

export async function getCurrentPrincipal(): Promise<Principal | null> {
  const cookieStore = await cookies();
  return principalFromSessionToken(cookieStore.get(SESSION_COOKIE)?.value);
}

export async function requirePermission(
  permission: Permission,
  scope: Scope = {}
): Promise<Principal> {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, permission, scope)) throw new AuthorizationError();
  return principal;
}

/** Lazily adopts the legacy environment administrator as the immutable first owner. */
async function ensureBootstrapOwner(identity: string, password: string) {
  const supplied = digest(password);
  const configured = digest(env.ADMIN_PASS);
  if (
    normalizeIdentity(identity) !== normalizeIdentity(env.ADMIN_USER) ||
    !crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(configured, "hex"))
  )
    return null;
  await seedAccessControl();
  return withDbTransaction(
    () =>
      db.transaction(
        async (tx) => {
          const [existing] = await tx
            .select()
            .from(adminUsers)
            .where(eq(adminUsers.email, normalizeIdentity(identity)))
            .limit(1);
          if (existing) return existing;
          const users = await tx.select({ id: adminUsers.id }).from(adminUsers).limit(1);
          if (users.length) return null; // bootstrap cannot create a second owner
          const [created] = await tx
            .insert(adminUsers)
            .values({
              email: normalizeIdentity(identity),
              displayName: identity.trim(),
              passwordHash: hashPassword(password),
            })
            .returning();
          await tx.insert(userRoleAssignments).values({ userId: created.id, roleId: "owner" });
          await tx.insert(auditLogs).values({
            actorType: "bootstrap",
            action: "access.bootstrap_owner",
            targetType: "user",
            targetId: created.id,
          });
          return created;
        },
        { isolationLevel: "serializable" }
      ),
    "bootstrap-owner-create"
  );
}

export async function authenticateLocalUser(
  identity: string,
  password: string
): Promise<{ id: string; displayName: string } | null> {
  const normalized = normalizeIdentity(identity);
  const existing = await withDbRead(
    () => db.select().from(adminUsers).where(eq(adminUsers.email, normalized)).limit(1),
    "local-auth-find"
  );
  let user: (typeof existing)[number] | null = existing[0] ?? null;
  if (!user) user = await ensureBootstrapOwner(identity, password);
  if (!user || user.status !== "active" || !verifyPassword(password, user.passwordHash))
    return null;
  await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        await tx
          .update(adminUsers)
          .set({ lastLoginAt: new Date(), updatedAt: new Date() })
          .where(eq(adminUsers.id, user.id));
        await tx.insert(auditLogs).values({
          actorType: "user",
          actorId: user.id,
          action: "access.login.local",
          targetType: "user",
          targetId: user.id,
        });
      }),
    "local-auth-login"
  );
  return { id: user.id, displayName: user.displayName };
}

export async function createUserSession(
  userId: string,
  metadata: { ip?: string; userAgent?: string } = {}
): Promise<string> {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const sessionId = crypto.randomUUID();
  const token = await createSessionToken(sessionId, expiresAt.getTime() - Date.now());
  await withDbWrite(
    () =>
      db.insert(adminSessions).values({
        id: sessionId,
        userId,
        tokenHash: digest(token),
        expiresAt,
        ip: metadata.ip ?? null,
        userAgent: metadata.userAgent ?? null,
      }),
    "create-admin-session"
  );
  return token;
}

export async function revokeSession(sessionId: string, actor: Principal): Promise<void> {
  await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        const updated = await tx
          .update(adminSessions)
          .set({ revokedAt: new Date() })
          .where(eq(adminSessions.id, sessionId))
          .returning({ id: adminSessions.id });
        if (updated.length === 0) throw new Error("session_not_found");
        await tx.insert(auditLogs).values({
          actorType: actor.type,
          actorId: actor.id,
          action: "access.session.revoke",
          targetType: "session",
          targetId: sessionId,
        });
      }),
    "revoke-admin-session"
  );
}

export async function createInvitation(
  input: { email: string; displayName: string; roleId: string; scope?: Scope },
  actor: Principal
): Promise<string> {
  await seedAccessControl();
  if (!SYSTEM_ROLES.some((role) => role.id === input.roleId)) throw new Error("Unknown role");
  const token = `vli_${crypto.randomBytes(32).toString("base64url")}`;
  const scopeType = input.scope?.type ?? "workspace";
  const scopeId = input.scope?.id ?? null;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        await tx.insert(adminInvitations).values({
          email: normalizeIdentity(input.email),
          displayName: input.displayName.trim(),
          tokenHash: digest(token),
          roleId: input.roleId,
          scopeType,
          scopeId,
          expiresAt,
          createdBy: actor.id,
        });
        await tx.insert(auditLogs).values({
          actorType: actor.type,
          actorId: actor.id,
          action: "access.invitation.create",
          targetType: "invitation",
          metadata: { email: normalizeIdentity(input.email), roleId: input.roleId, scopeType },
        });
      }),
    "create-admin-invitation"
  );
  return token;
}

export async function acceptInvitation(
  token: string,
  password: string
): Promise<{ id: string; displayName: string } | null> {
  if (password.length < 12) throw new Error("Use a password with at least 12 characters");
  const tokenHash = digest(token);
  return withDbTransaction(
    () =>
      db.transaction(
        async (tx) => {
          const [invitation] = await tx
            .select()
            .from(adminInvitations)
            .where(
              and(
                eq(adminInvitations.tokenHash, tokenHash),
                isNull(adminInvitations.acceptedAt),
                gt(adminInvitations.expiresAt, new Date())
              )
            )
            .limit(1);
          if (!invitation) return null;
          const [existing] = await tx
            .select()
            .from(adminUsers)
            .where(eq(adminUsers.email, invitation.email))
            .limit(1);
          let userId: string;
          let displayName: string;
          if (existing) {
            if (existing.status === "suspended") return null;
            userId = existing.id;
            displayName = existing.displayName;
            await tx
              .update(adminUsers)
              .set({
                passwordHash: hashPassword(password),
                status: "active",
                updatedAt: new Date(),
              })
              .where(eq(adminUsers.id, userId));
          } else {
            const [created] = await tx
              .insert(adminUsers)
              .values({
                email: invitation.email,
                displayName: invitation.displayName,
                passwordHash: hashPassword(password),
              })
              .returning({ id: adminUsers.id, displayName: adminUsers.displayName });
            userId = created.id;
            displayName = created.displayName;
          }
          await tx.insert(userRoleAssignments).values({
            userId,
            roleId: invitation.roleId,
            scopeType: invitation.scopeType,
            scopeId: invitation.scopeId,
          });
          await tx
            .update(adminInvitations)
            .set({ acceptedAt: new Date() })
            .where(eq(adminInvitations.id, invitation.id));
          await tx.insert(auditLogs).values({
            actorType: "user",
            actorId: userId,
            action: "access.invitation.accept",
            targetType: "invitation",
            targetId: invitation.id,
          });
          return { id: userId, displayName };
        },
        { isolationLevel: "serializable" }
      ),
    "accept-admin-invitation"
  );
}

export async function createServiceAccount(
  input: { name: string; permissions: Permission[]; expiresAt?: Date | null },
  actor: Principal
): Promise<{ id: string; token: string }> {
  if (
    !input.name.trim() ||
    input.permissions.length === 0 ||
    input.permissions.some((permission) => !PERMISSIONS.includes(permission))
  ) {
    throw new Error("A service account needs a name and at least one valid permission");
  }
  const { token, prefix, hash } = issueServiceAccountToken();
  const [account] = await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        const created = await tx
          .insert(serviceAccounts)
          .values({
            name: input.name.trim(),
            tokenPrefix: prefix,
            tokenHash: hash,
            expiresAt: input.expiresAt ?? null,
            createdBy: actor.id,
          })
          .returning({ id: serviceAccounts.id });
        for (const permission of input.permissions) {
          await tx
            .insert(serviceAccountPermissions)
            .values({ serviceAccountId: created[0].id, permission });
        }
        await tx.insert(auditLogs).values({
          actorType: actor.type,
          actorId: actor.id,
          action: "access.service_account.create",
          targetType: "service_account",
          targetId: created[0].id,
          metadata: { permissions: input.permissions },
        });
        return created;
      }),
    "create-service-account"
  );
  return { id: account.id, token };
}

function issueServiceAccountToken(): { token: string; prefix: string; hash: string } {
  const token = `vls_${crypto.randomBytes(32).toString("base64url")}`;
  return { token, prefix: token.slice(0, 12), hash: digest(token) };
}

/**
 * Replace an active automation credential without ever persisting plaintext.
 * The old token becomes invalid in the same transaction in which the rotation
 * is audited; callers receive the replacement exactly once.
 */
export async function rotateServiceAccountToken(
  id: string,
  actor: Principal
): Promise<{ token: string }> {
  const secret = issueServiceAccountToken();
  await withAuditedTransaction(
    actor,
    {
      action: "access.service_account.rotate",
      targetType: "service_account",
      targetId: id,
      metadata: { tokenPrefix: secret.prefix },
    },
    async (tx) => {
      const updated = await tx
        .update(serviceAccounts)
        .set({ tokenPrefix: secret.prefix, tokenHash: secret.hash })
        .where(and(eq(serviceAccounts.id, id), eq(serviceAccounts.status, "active")))
        .returning({ id: serviceAccounts.id });
      if (updated.length === 0) throw new Error("service_account_not_active");
    },
    "rotate-service-account-token"
  );
  return { token: secret.token };
}

async function principalFromServiceToken(token: string): Promise<Principal | null> {
  const [account] = await withDbRead(
    () =>
      db
        .select()
        .from(serviceAccounts)
        .where(
          and(
            eq(serviceAccounts.tokenHash, digest(token)),
            eq(serviceAccounts.status, "active"),
            or(isNull(serviceAccounts.expiresAt), gt(serviceAccounts.expiresAt, new Date()))
          )
        )
        .limit(1),
    "service-account-principal"
  );
  if (!account) return null;
  const permissions = await withDbRead(
    () =>
      db
        .select({
          permission: serviceAccountPermissions.permission,
          scopeType: serviceAccountPermissions.scopeType,
          scopeId: serviceAccountPermissions.scopeId,
        })
        .from(serviceAccountPermissions)
        .where(eq(serviceAccountPermissions.serviceAccountId, account.id)),
    "service-account-permissions"
  );
  await withDbWrite(
    () =>
      db
        .update(serviceAccounts)
        .set({ lastUsedAt: new Date() })
        .where(eq(serviceAccounts.id, account.id)),
    "service-account-last-used"
  ).catch((error) =>
    log.warn("Failed to update service account last-used timestamp", {
      accountId: account.id,
      error: String(error),
    })
  );
  return { type: "service_account", id: account.id, displayName: account.name, permissions };
}

export async function getRequestPrincipal(request: Request): Promise<Principal | null> {
  const cookie = request.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  const sessionPrincipal = await principalFromSessionToken(cookie);
  if (sessionPrincipal) return sessionPrincipal;
  const token = request.headers.get("x-api-key")?.trim();
  if (!token) return null;
  const servicePrincipal = await principalFromServiceToken(token);
  if (servicePrincipal) return servicePrincipal;
  // Transitional compatibility only: deployment must rotate this global secret
  // to a scoped service account and remove ADMIN_API_KEY after migration.
  if (await safeEqualSecret(token, env.ADMIN_API_KEY)) {
    return {
      type: "bootstrap",
      id: "legacy-api-key",
      displayName: "Legacy API key",
      permissions: [{ permission: "*", scopeType: "workspace", scopeId: null }],
    };
  }
  return null;
}

export async function requestHasPermission(
  request: Request,
  permission: Permission,
  scope: Scope = {}
): Promise<boolean> {
  return hasPermission(await getRequestPrincipal(request), permission, scope);
}

export async function writeAudit(
  actor: Principal,
  action: string,
  targetType: string,
  targetId?: string | null,
  metadata: Record<string, unknown> = {},
  outcome: "success" | "failure" = "success"
): Promise<void> {
  await withDbWrite(
    () =>
      db.insert(auditLogs).values({
        actorType: actor.type,
        actorId: actor.id,
        action,
        targetType,
        targetId: targetId ?? null,
        metadata,
        outcome,
      }),
    "write-audit-log"
  );
}

/**
 * Commit a state change and its security audit record as one database unit.
 * Callers never observe a successful mutation without the corresponding audit
 * event, nor a misleading failure after the mutation already committed.
 */
export async function withAuditedTransaction<T>(
  actor: Principal,
  event: AuditEvent | ((result: T) => AuditEvent),
  operation: (tx: DbTransaction) => Promise<T>,
  label: string,
  isolationLevel: "read committed" | "repeatable read" | "serializable" = "read committed"
): Promise<T> {
  return withDbTransaction(
    () =>
      db.transaction(
        async (tx) => {
          const result = await operation(tx);
          const resolvedEvent = typeof event === "function" ? event(result) : event;
          await tx.insert(auditLogs).values({
            actorType: actor.type,
            actorId: actor.id,
            action: resolvedEvent.action,
            targetType: resolvedEvent.targetType,
            targetId: resolvedEvent.targetId ?? null,
            metadata: resolvedEvent.metadata ?? {},
            outcome: resolvedEvent.outcome ?? "success",
          });
          return result;
        },
        { isolationLevel }
      ),
    label
  );
}
