import type { Metadata } from 'next';
import { ResourcesPage } from '../../../components/website/pages/resources/ResourcesPage';

export const metadata: Metadata = {
  title: 'Resources · TManage',
  description: 'Practical playbooks, templates and product notes from the TManage team.',
};

/** WEB-15 — public resources library (blog & guides), routed at `/resources`. */
export default function ResourcesRoute() {
  return <ResourcesPage />;
}
