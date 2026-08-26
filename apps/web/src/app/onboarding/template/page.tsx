import { OperatingTemplateScreen } from '../../../components/screens/OperatingTemplateScreen';
import { FIXTURE_SIGNED_IN_AS } from '../../../lib/fixtures';

/** **ON-02 Choose operating template.** */
export default function OperatingTemplatePage() {
  return <OperatingTemplateScreen signedInAs={FIXTURE_SIGNED_IN_AS} />;
}
