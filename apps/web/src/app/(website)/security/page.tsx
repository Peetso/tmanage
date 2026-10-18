import type { Metadata } from 'next';
import { SecurityPage } from '../../../components/website/pages/security/SecurityPage';

/**
 * **Security & trust** — the public `/security` page (SITE-SPEC "PAGE: Security & trust").
 * The sections live in `components/website/pages/security/`; this route only names the page.
 */
export const metadata: Metadata = {
  title: 'Security & trust',
  description:
    'Isolation is enforced in the database, not the interface. Every list, lookup, search, file link and notification is scoped to your organization.',
};

export default function SecurityRoute() {
  return <SecurityPage />;
}
