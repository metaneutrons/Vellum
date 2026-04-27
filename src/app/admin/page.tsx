// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { redirect } from "next/navigation";

export default function AdminPage() {
  redirect("/admin/devices");
}
