import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { routeTitle } from '../../../lib/route-titles';

/** Gives the client page `/unsubscribe/[token]` its tab title (PERSONMAIL). */
export const metadata: Metadata = {
  title: routeTitle('/unsubscribe/[token]'),
  referrer: 'no-referrer',
};

export default function UnsubscribeLayout({ children }: { children: ReactNode }) {
  return children;
}
