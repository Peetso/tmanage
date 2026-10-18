import type { Metadata } from 'next';
import { CustomersPage } from '../../../components/website/pages/customers/CustomersPage';

/**
 * **Customers & stories** — routed at `/customers` (SITE-SPEC "PAGE: Customers & stories",
 * Figma shot 14-customers). TManage has no public customers yet, so every logo, story and quote
 * here is a marked design-partner placeholder.
 */
export const metadata: Metadata = {
  title: 'Customers & stories · TManage',
  description:
    'Stories from our design-partner programme — what changed when the work became one story.',
};

export default function CustomersRoute() {
  return <CustomersPage />;
}
