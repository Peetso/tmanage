import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * 55-14 — the mailed sign-in link carries a secret token in its path: never index it and never
 * send it on as a referrer (the API answers its own link routes with the same rules).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function PortalMagicLinkLayout({ children }: { children: ReactNode }) {
  return children;
}
