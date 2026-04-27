// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminNav } from "./nav";
import { ToastProvider } from "@/components/toast";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  if (cookieStore.get("admin_session")?.value !== "authenticated") {
    redirect("/login");
  }

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-gray-50">
        <AdminNav />
        <main className="flex-1 p-4 md:p-8 pl-14 md:pl-8">{children}</main>
      </div>
    </ToastProvider>
  );
}
