// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAllRefreshProfiles } from "../actions";
import { ProfileList } from "./profile-list";
import { getCurrentPrincipal, hasPermission } from "@/lib/access";

export default async function ProfilesPage() {
  const [profiles, principal] = await Promise.all([getAllRefreshProfiles(), getCurrentPrincipal()]);
  return (
    <ProfileList profiles={profiles} canManage={hasPermission(principal, "profiles.manage")} />
  );
}
