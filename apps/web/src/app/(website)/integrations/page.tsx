import type { Metadata } from 'next';
import { IntegrationsPage } from '../../../components/website/pages/integrations/IntegrationsPage';

export const metadata: Metadata = {
  title: 'Integrations · TManage',
  description:
    'Connect the tools you keep. Calendars, storage, sign-in and developer tools — each connection shows exactly what it can read and do.',
};

/** WEB-13 — public integrations page, routed at `/integrations`. */
export default function IntegrationsRoute() {
  return <IntegrationsPage />;
}
