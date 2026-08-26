import { OrganizationSelectorScreen } from '../../components/screens/OrganizationSelectorScreen';
import { FIXTURE_ORGANIZATIONS } from '../../lib/fixtures';

/**
 * **ID-04 Organization selector.**
 *
 * The list is a fixture. `TEN-001` never built "list the organizations this person belongs
 * to", and the screen says so on the page rather than only here.
 */
export default function OrganizationsPage() {
  return <OrganizationSelectorScreen organizations={FIXTURE_ORGANIZATIONS} />;
}
