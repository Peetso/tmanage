import type { Metadata } from 'next';
import { IntegrationsPage } from '../../../components/website/pages/integrations/IntegrationsPage';

export const metadata: Metadata = {
  title: 'Integrations',
  description:
    'Integrations that work today. Every status on this page matches the product: what works now, what connects with your own account, and what is planned.',
};

/** WEB-13 / 54-02 — public integrations page, routed at `/integrations`. */
export default function IntegrationsRoute() {
  return <IntegrationsPage />;
}
