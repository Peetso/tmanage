import { CreateOrganizationScreen } from '../../../components/screens/CreateOrganizationScreen';
import { FIXTURE_SIGNED_IN_AS } from '../../../lib/fixtures';

/** **ON-01 Create organization.** */
export default function CreateOrganizationPage() {
  return <CreateOrganizationScreen signedInAs={FIXTURE_SIGNED_IN_AS} />;
}
