import { FirstProjectScreen } from '../../../components/screens/FirstProjectScreen';
import { FIXTURE_OWNERS, FIXTURE_SIGNED_IN_AS } from '../../../lib/fixtures';

/** **ON-03 Create first project.** */
export default function FirstProjectPage() {
  return <FirstProjectScreen signedInAs={FIXTURE_SIGNED_IN_AS} owners={FIXTURE_OWNERS} />;
}
