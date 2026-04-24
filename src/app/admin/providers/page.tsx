import { getAllProviders } from "../actions";
import { ProviderList } from "./provider-list";

export default async function ProvidersPage() {
  const providers = await getAllProviders();
  return <ProviderList providers={providers} />;
}
