import { OrganizationSelectorScreen } from '../../components/screens/OrganizationSelectorScreen';

/**
 * **ID-04 Organization selector.**
 *
 * The screen fetches its own list from `GET /v1/organizations`. It took a fixture until
 * TEN-001's second half landed; the page now passes nothing, because there is nothing left to
 * pass.
 */
export default function OrganizationsPage() {
  return <OrganizationSelectorScreen />;
}
