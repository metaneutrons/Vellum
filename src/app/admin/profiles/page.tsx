// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAllRefreshProfiles } from "../actions";
import { ProfileList } from "./profile-list";

export default async function ProfilesPage() {
  const profiles = await getAllRefreshProfiles();
  return <ProfileList profiles={profiles} />;
}
