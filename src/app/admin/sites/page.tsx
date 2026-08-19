// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import {
  getAllSites,
  getAllThemes,
  getAllRefreshProfiles,
  getAllContentInstances,
} from "../actions";
import { SiteList } from "./site-list";

export default async function SitesPage() {
  const [sites, themes, profiles, content] = await Promise.all([
    getAllSites(),
    getAllThemes(),
    getAllRefreshProfiles(),
    getAllContentInstances(),
  ]);
  return <SiteList sites={sites} themes={themes} profiles={profiles} contentInstances={content} />;
}
