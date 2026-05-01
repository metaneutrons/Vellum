// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import {
  getAllContentInstances,
  getAllContentTypes,
  getAllProviders,
  getKnownDisplaySizes,
} from "../actions";
import { ContentList } from "./content-list";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const { edit } = await searchParams;
  const [instances, types, providers, knownDisplays] = await Promise.all([
    getAllContentInstances(),
    getAllContentTypes(),
    getAllProviders(),
    getKnownDisplaySizes(),
  ]);

  return (
    <ContentList
      instances={instances}
      types={types}
      providers={providers}
      knownDisplays={knownDisplays}
      initialEditId={edit}
    />
  );
}
