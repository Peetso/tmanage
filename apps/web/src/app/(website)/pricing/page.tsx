import type { Metadata } from 'next';
import { PricingPage } from '../../../components/website/pages/pricing/PricingPage';

export const metadata: Metadata = {
  title: 'Pricing — TManage',
  description:
    'Priced per internal seat. Clients, guests and approvers join their portal at no cost, on every plan.',
};

/** Public pricing page (`/pricing`), built from the website layer. Needs no session or API. */
export default function PricingRoute() {
  return <PricingPage />;
}
