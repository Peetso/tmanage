import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * A12 — the quote link page carries a secret token in its path: never index it and never send it
 * on as a referrer (the API already answers its own routes with the same rules).
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function PublicQuoteLayout({ children }: { children: ReactNode }) {
  return children;
}
