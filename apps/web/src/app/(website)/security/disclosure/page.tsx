import type { Metadata } from 'next';
import { DisclosurePage } from '../../../../components/website/pages/disclosure/DisclosurePage';

/**
 * **Report a security problem** — the public `/security/disclosure` page (56-17): where to send a
 * vulnerability report, the scope, the safe-harbour promise and the response times.
 */
export const metadata: Metadata = {
  title: 'Report a security problem',
  description:
    'How to report a security weakness in TManage privately, what is in scope, our safe-harbour promise and how fast we answer.',
};

export default function DisclosureRoute() {
  return <DisclosurePage />;
}
