// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Shared provider utilities — DRY helper for credential resolution.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataProviders } from "@/db/schema";
import { decryptCredentials } from "@/lib/encryption";

export interface ResolvedProvider {
  id: string;
  type: string;
  name: string;
  credentials: Record<string, unknown>;
}

/**
 * Load a provider by ID and decrypt its credentials.
 * Throws if not found.
 */
export async function getProviderWithCredentials(id: string): Promise<ResolvedProvider> {
  const [provider] = await db.select().from(dataProviders)
    .where(eq(dataProviders.id, id)).limit(1);
  if (!provider) throw new Error(`Provider ${id} not found`);

  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    credentials: decryptCredentials(provider.encryptedCredentials) as Record<string, unknown>,
  };
}
