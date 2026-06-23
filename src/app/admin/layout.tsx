// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminNav } from "./nav";
import { ToastProvider } from "@/components/toast";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  if (!(await verifySessionToken(cookieStore.get(SESSION_COOKIE)?.value))) {
    redirect("/login");
  }

  return (
    <ToastProvider>
      {/* Aurora shell + neutral content canvas. Un-migrated pages opt into the
          legacy skin themselves (strangler); migrated pages render clean Aurora. */}
      <div className="flex min-h-dvh bg-bg-secondary text-label">
        <AdminNav />
        <main className="flex-1 min-w-0 p-4 md:p-8 pt-16 md:pt-8">{children}</main>
      </div>
    </ToastProvider>
  );
}
