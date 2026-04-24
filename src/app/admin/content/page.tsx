import {
  getAllContentInstances,
  getAllContentTypes,
  getAllProviders,
} from "../actions";
import { ContentList } from "./content-list";

export default async function ContentPage() {
  const [instances, types, providers] = await Promise.all([
    getAllContentInstances(),
    getAllContentTypes(),
    getAllProviders(),
  ]);

  return (
    <ContentList
      instances={instances}
      types={types}
      providers={providers}
    />
  );
}
