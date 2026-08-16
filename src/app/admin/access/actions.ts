// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, withDbRead, withDbTransaction } from "@/db";
import {
  accessRoles,
  adminSessions,
  adminUsers,
  auditLogs,
  serviceAccounts,
  userRoleAssignments,
} from "@/db/schema";
import {
  SYSTEM_ROLES,
  createInvitation,
  createServiceAccount,
  requirePermission,
  rotateServiceAccountToken,
  type Permission,
  withAuditedTransaction,
} from "@/lib/access";
import { cacheCommittedSetting, getAllSettings, setSettingInTransaction } from "@/lib/settings";

export async function getAccessDirectory() {
  await requirePermission("access.read");
  const [users, assignments, accounts, events, policy] = await Promise.all([
    withDbRead(
      () =>
        db
          .select({
            id: adminUsers.id,
            email: adminUsers.email,
            displayName: adminUsers.displayName,
            status: adminUsers.status,
            mfaRequired: adminUsers.mfaRequired,
            mfaEnrolledAt: adminUsers.mfaEnrolledAt,
            lastLoginAt: adminUsers.lastLoginAt,
            createdAt: adminUsers.createdAt,
          })
          .from(adminUsers)
          .orderBy(adminUsers.createdAt),
      "access-list-users"
    ),
    withDbRead(
      () =>
        db
          .select({
            userId: userRoleAssignments.userId,
            roleId: accessRoles.id,
            roleName: accessRoles.name,
            scopeType: userRoleAssignments.scopeType,
            scopeId: userRoleAssignments.scopeId,
          })
          .from(userRoleAssignments)
          .innerJoin(accessRoles, eq(userRoleAssignments.roleId, accessRoles.id)),
      "access-list-assignments"
    ),
    withDbRead(
      () =>
        db
          .select({
            id: serviceAccounts.id,
            name: serviceAccounts.name,
            tokenPrefix: serviceAccounts.tokenPrefix,
            status: serviceAccounts.status,
            expiresAt: serviceAccounts.expiresAt,
            lastUsedAt: serviceAccounts.lastUsedAt,
            createdAt: serviceAccounts.createdAt,
          })
          .from(serviceAccounts)
          .orderBy(serviceAccounts.createdAt),
      "access-list-service-accounts"
    ),
    withDbRead(
      () =>
        db
          .select({
            id: auditLogs.id,
            actorType: auditLogs.actorType,
            actorId: auditLogs.actorId,
            action: auditLogs.action,
            targetType: auditLogs.targetType,
            targetId: auditLogs.targetId,
            outcome: auditLogs.outcome,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .orderBy(desc(auditLogs.createdAt))
          .limit(100),
      "access-list-audit"
    ),
    getAllSettings(),
  ]);
  return { users, assignments, accounts, events, policy, roles: SYSTEM_ROLES };
}

export async function updateOidcProvisioningPolicy(autoProvision: boolean, defaultRole: string) {
  const actor = await requirePermission("access.manage");
  if (!SYSTEM_ROLES.some((role) => role.id === defaultRole && role.id !== "owner"))
    throw new Error("OIDC provisioning cannot grant Owner access");
  await withAuditedTransaction(
    actor,
    {
      action: "access.oidc.policy.update",
      targetType: "access_policy",
      targetId: "oidc",
      metadata: { autoProvision, defaultRole },
    },
    async (tx) => {
      await setSettingInTransaction(tx, "access.oidcAutoProvision", autoProvision);
      await setSettingInTransaction(tx, "access.oidcDefaultRole", defaultRole);
    },
    "update-oidc-provisioning-policy"
  );
  cacheCommittedSetting("access.oidcAutoProvision", autoProvision);
  cacheCommittedSetting("access.oidcDefaultRole", defaultRole);
  revalidatePath("/admin/access");
}

export async function inviteUser(input: { email: string; displayName: string; roleId: string }) {
  const actor = await requirePermission("access.manage");
  const token = await createInvitation(input, actor);
  revalidatePath("/admin/access");
  // Delivery is intentionally delegated to the organization’s mail/IdP flow.
  // This one-time link must only be shown to the inviting owner once.
  return token;
}

export async function changeUserRole(userId: string, roleId: string) {
  const actor = await requirePermission("access.manage");
  if (!SYSTEM_ROLES.some((role) => role.id === roleId)) throw new Error("Unknown role");
  if (actor.id === userId && roleId !== "owner")
    throw new Error("You cannot remove your own owner access");
  await withDbTransaction(
    () =>
      db.transaction(
        async (tx) => {
          const [target] = await tx
            .select({ id: adminUsers.id })
            .from(adminUsers)
            .where(eq(adminUsers.id, userId))
            .limit(1);
          if (!target) throw new Error("User not found");
          const existing = await tx
            .select({ roleId: userRoleAssignments.roleId })
            .from(userRoleAssignments)
            .where(eq(userRoleAssignments.userId, userId));
          if (existing.some((assignment) => assignment.roleId === "owner") && roleId !== "owner") {
            const owners = await tx
              .select({ userId: userRoleAssignments.userId })
              .from(userRoleAssignments)
              .where(
                and(
                  eq(userRoleAssignments.roleId, "owner"),
                  eq(userRoleAssignments.scopeType, "workspace")
                )
              );
            if (owners.length <= 1) throw new Error("Vellum must retain at least one owner");
          }
          await tx.delete(userRoleAssignments).where(eq(userRoleAssignments.userId, userId));
          await tx.insert(userRoleAssignments).values({ userId, roleId });
          await tx.insert(auditLogs).values({
            actorType: actor.type,
            actorId: actor.id,
            action: "access.user.role_change",
            targetType: "user",
            targetId: userId,
            metadata: { roleId },
          });
        },
        { isolationLevel: "serializable" }
      ),
    "access-change-user-role"
  );
  revalidatePath("/admin/access");
}

export async function suspendUser(userId: string) {
  const actor = await requirePermission("access.manage");
  if (actor.id === userId) throw new Error("You cannot suspend your own account");
  await withDbTransaction(
    () =>
      db.transaction(
        async (tx) => {
          const target = await tx
            .select({ id: adminUsers.id })
            .from(adminUsers)
            .where(eq(adminUsers.id, userId))
            .limit(1);
          if (target.length === 0) throw new Error("User not found");
          const roles = await tx
            .select({ roleId: userRoleAssignments.roleId })
            .from(userRoleAssignments)
            .where(eq(userRoleAssignments.userId, userId));
          if (roles.some((role) => role.roleId === "owner")) {
            const owners = await tx
              .select({ userId: userRoleAssignments.userId })
              .from(userRoleAssignments)
              .where(
                and(
                  eq(userRoleAssignments.roleId, "owner"),
                  eq(userRoleAssignments.scopeType, "workspace")
                )
              );
            if (owners.length <= 1) throw new Error("Vellum must retain at least one owner");
          }
          await tx
            .update(adminUsers)
            .set({ status: "suspended", updatedAt: new Date() })
            .where(eq(adminUsers.id, userId));
          await tx
            .update(adminSessions)
            .set({ revokedAt: new Date() })
            .where(and(eq(adminSessions.userId, userId), isNull(adminSessions.revokedAt)));
          await tx.insert(auditLogs).values({
            actorType: actor.type,
            actorId: actor.id,
            action: "access.user.suspend",
            targetType: "user",
            targetId: userId,
          });
        },
        { isolationLevel: "serializable" }
      ),
    "access-suspend-user"
  );
  revalidatePath("/admin/access");
}

export async function createAutomationAccount(name: string, permissions: Permission[]) {
  const actor = await requirePermission("access.manage");
  const result = await createServiceAccount({ name, permissions }, actor);
  revalidatePath("/admin/access");
  return result;
}

export async function revokeAutomationAccount(id: string) {
  const actor = await requirePermission("access.manage");
  await withDbTransaction(
    () =>
      db.transaction(async (tx) => {
        const updated = await tx
          .update(serviceAccounts)
          .set({ status: "revoked" })
          .where(eq(serviceAccounts.id, id))
          .returning({ id: serviceAccounts.id });
        if (updated.length === 0) throw new Error("service_account_not_found");
        await tx.insert(auditLogs).values({
          actorType: actor.type,
          actorId: actor.id,
          action: "access.service_account.revoke",
          targetType: "service_account",
          targetId: id,
        });
      }),
    "access-revoke-service-account"
  );
  revalidatePath("/admin/access");
}

export async function rotateAutomationAccountKey(id: string) {
  const actor = await requirePermission("access.manage");
  const result = await rotateServiceAccountToken(id, actor);
  revalidatePath("/admin/access");
  return result;
}

export async function deleteAutomationAccount(id: string) {
  const actor = await requirePermission("access.manage");
  await withAuditedTransaction(
    actor,
    {
      action: "access.service_account.delete",
      targetType: "service_account",
      targetId: id,
    },
    async (tx) => {
      const deleted = await tx
        .delete(serviceAccounts)
        .where(eq(serviceAccounts.id, id))
        .returning({ id: serviceAccounts.id });
      if (deleted.length === 0) throw new Error("service_account_not_found");
    },
    "access-delete-service-account"
  );
  revalidatePath("/admin/access");
}
