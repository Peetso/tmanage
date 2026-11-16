import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { routeTitle } from '../../../lib/route-titles';

/** Gives the client page `/confirm-email/[token]` its tab title (VERIFYMAIL). */
export const metadata: Metadata = { title: routeTitle('/confirm-email/[token]') };

export default function ConfirmEmailLayout({ children }: { children: ReactNode }) {
  return children;
}
