import type { Metadata } from 'next';
import { PricingPage } from '../../../components/website/pages/pricing/PricingPage';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'TManage is free for everyone during the beta. No card needed, and client users are always free.',
};

/** Public pricing page (`/pricing`), built from the website layer. Needs no session or API. */
export default function PricingRoute() {
  return <PricingPage />;
}
