// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAllProviders } from "../actions";
import { ProviderList } from "./provider-list";

export default async function ProvidersPage() {
  const providers = await getAllProviders();
  return <ProviderList providers={providers} />;
}
