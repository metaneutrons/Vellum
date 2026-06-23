// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getAllThemes } from "../actions";
import { ThemeEditor } from "./theme-editor";

export default async function ThemesPage() {
  const themeList = await getAllThemes();
  // TODO(aurora): migrate this screen off legacy-skin.
  return <div className="legacy-skin"><ThemeEditor themes={themeList} /></div>;
}
