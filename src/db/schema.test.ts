// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  contentInstances,
  contentAssetDependencies,
  contentProviderDependencies,
  assets,
  adminInvitations,
  adminSessions,
  dataProviders,
  devices,
  otaEvents,
  oidcIdentities,
  refreshProfiles,
  reports,
  rolePermissions,
  serviceAccountPermissions,
  serviceAccounts,
  telemetry,
  themes,
  userRoleAssignments,
} from "./schema";

describe("device-owned records", () => {
  it.each([
    ["telemetry", telemetry],
    ["reports", reports],
    ["OTA events", otaEvents],
  ])("deletes %s with its device", (_name, table) => {
    const deviceReference = getTableConfig(table).foreignKeys.find(
      (foreignKey) => foreignKey.reference().foreignTable === devices
    );

    expect(deviceReference, "device foreign key").toBeDefined();
    expect(deviceReference?.onDelete).toBe("cascade");
  });
});

describe("device assignments", () => {
  it.each([
    ["content", contentInstances],
    ["theme", themes],
    ["refresh profile", refreshProfiles],
  ])("clears an assigned %s when it is deleted", (_name, parent) => {
    const reference = getTableConfig(devices).foreignKeys.find(
      (foreignKey) => foreignKey.reference().foreignTable === parent
    );

    expect(reference, "assignment foreign key").toBeDefined();
    expect(reference?.onDelete).toBe("set null");
  });
});

describe("database-selected defaults", () => {
  it.each([
    ["theme", themes, "themes_one_default_idx"],
    ["refresh profile", refreshProfiles, "refresh_profiles_one_default_idx"],
  ])("allows only one default %s", (_name, table, indexName) => {
    const index = getTableConfig(table).indexes.find(
      (candidate) => candidate.config.name === indexName
    );

    expect(index, "partial unique index").toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
  });
});

describe("JSON content dependencies", () => {
  it.each([
    ["provider", contentProviderDependencies, dataProviders],
    ["asset", contentAssetDependencies, assets],
  ])("restricts deletion of a referenced %s", (_name, dependencyTable, parent) => {
    const config = getTableConfig(dependencyTable);
    const contentReference = config.foreignKeys.find(
      (key) => key.reference().foreignTable === contentInstances
    );
    const resourceReference = config.foreignKeys.find(
      (key) => key.reference().foreignTable === parent
    );

    expect(contentReference?.onDelete).toBe("cascade");
    expect(resourceReference?.onDelete).toBe("restrict");
  });
});

describe("foreign-key performance", () => {
  it.each([
    rolePermissions,
    userRoleAssignments,
    adminSessions,
    adminInvitations,
    oidcIdentities,
    serviceAccounts,
    serviceAccountPermissions,
    devices,
    contentProviderDependencies,
    contentAssetDependencies,
    telemetry,
    reports,
    otaEvents,
  ])("indexes every foreign key on $name", (table) => {
    const config = getTableConfig(table);
    const leadingColumns = [
      ...config.indexes.map((candidate) => candidate.config.columns[0]),
      ...config.primaryKeys.map((candidate) => candidate.columns[0]),
    ].filter((column) => column !== undefined);

    for (const foreignKey of config.foreignKeys) {
      const localColumn = foreignKey.reference().columns[0]!;
      expect(
        leadingColumns.some((column) => "name" in column && column.name === localColumn.name),
        `${config.name}.${localColumn.name} needs a leading index`
      ).toBe(true);
    }
  });
});
