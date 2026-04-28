// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

export const locales = ["en", "de", "fr", "it", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export default getRequestConfig(async () => {
  // 1. Check cookie (manual override)
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("locale")?.value;
  if (cookieLocale && locales.includes(cookieLocale as Locale)) {
    return {
      locale: cookieLocale,
      messages: (await import(`./messages/${cookieLocale}.json`)).default,
    };
  }

  // 2. Auto-detect from Accept-Language header
  const headerStore = await headers();
  const acceptLang = headerStore.get("accept-language") ?? "";
  const detected = acceptLang
    .split(",")
    .map((s) => s.split(";")[0].trim().split("-")[0].toLowerCase())
    .find((l) => locales.includes(l as Locale));

  const locale = (detected as Locale) ?? defaultLocale;
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
  };
});
