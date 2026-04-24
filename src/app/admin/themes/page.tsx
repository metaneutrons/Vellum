import { getAllThemes } from "../actions";
import { ThemeEditor } from "./theme-editor";

export default async function ThemesPage() {
  const themeList = await getAllThemes();
  return <ThemeEditor themes={themeList} />;
}
