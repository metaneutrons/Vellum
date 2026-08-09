// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getTranslations } from "next-intl/server";
import { getAccessDirectory } from "./actions";
import { AccessManager } from "./access-manager";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const t = await getTranslations("access");
  const policy = await getTranslations("accessPolicy");
  const directory = await getAccessDirectory();
  return <AccessManager directory={directory} labels={{
    title: t("title"), description: t("description"), people: t("people"),
    serviceAccounts: t("serviceAccounts"), audit: t("audit"), invite: t("invite"),
    name: t("name"), email: t("email"), role: t("role"), status: t("status"),
    lastLogin: t("lastLogin"), createAccount: t("createAccount"), permissions: t("permissions"),
    copyToken: t("copyToken"), revoke: t("revoke"), suspend: t("suspend"), active: t("active"),
    suspended: t("suspended"), never: t("never"), created: t("created"),
    inviteCreated: t("inviteCreated"), accountCreated: t("accountCreated"), oidc: policy("oidc"),
    autoProvision: policy("autoProvision"), defaultRole: policy("defaultRole"), savePolicy: policy("savePolicy"),
  }} />;
}
