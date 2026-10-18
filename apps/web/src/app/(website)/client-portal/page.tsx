import type { Metadata } from 'next';
import { ClientPortalPage } from '../../../components/website/pages/client-portal/ClientPortalPage';

/**
 * **Client portal (WEB-07).** The public page about the client portal: what a client sees in
 * thirty seconds, approvals, requests, the allowlisted projection, free client seats and the
 * Arabic portal. Every section lives in `components/website/pages/client-portal`.
 */
export const metadata: Metadata = {
  title: 'Client portal — TManage',
  description:
    'Give clients one calm place for progress, reviews and files — generated from your work, never copied into it.',
};

export default function ClientPortalRoute() {
  return <ClientPortalPage />;
}
