import { getAllRefreshProfiles } from "../actions";
import { ProfileList } from "./profile-list";

export default async function ProfilesPage() {
  const profiles = await getAllRefreshProfiles();
  return <ProfileList profiles={profiles} />;
}
