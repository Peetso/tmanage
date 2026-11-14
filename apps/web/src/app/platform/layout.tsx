import type { ReactNode } from 'react';

/**
 * FIX6 locale flash: rendered per request, so the first HTML is in the member's saved language
 * (`lib/i18n/server-html-attributes.ts`) rather than the English prerender.
 */
export const dynamic = 'force-dynamic';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return children;
}
