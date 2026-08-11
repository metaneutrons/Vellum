// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { redirect } from "next/navigation";
import { AdminNav } from "./nav";
import { AppFooter } from "@/components/app-footer";
import { ToastProvider } from "@/components/toast";
import { getCurrentPrincipal, hasPermission } from "@/lib/access";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    redirect("/login");
  }

  return (
    <ToastProvider>
      {/* Aurora shell + neutral content canvas. Un-migrated pages opt into the
          legacy skin themselves (strangler); migrated pages render clean Aurora. */}
      <div className="flex min-h-dvh bg-bg-secondary text-label">
        <AdminNav
          canAccessManagement={hasPermission(principal, "access.read")}
          canReadSystem={hasPermission(principal, "system.read") || hasPermission(principal, "system.update")}
        />
        <div className="flex-1 min-w-0 flex flex-col">
          <main className="flex-1 min-w-0 p-4 md:p-8 pt-16 md:pt-8">{children}</main>
          <AppFooter className="px-4 md:px-8 py-4 border-t border-separator/60 text-label-tertiary" />
        </div>
      </div>
    </ToastProvider>
  );
}
