// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { isEntraConfigured } from "@/lib/access/entra-oidc";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return <LoginForm entraEnabled={isEntraConfigured()} />;
}
