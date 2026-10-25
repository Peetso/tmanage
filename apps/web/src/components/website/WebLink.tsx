'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';
import { localizeHref } from '../../lib/i18n/public-locale-routes';
import { useRouteLocale } from '../../lib/i18n/route-locale';

/**
 * `next/link` for the public website. On an Arabic public page (`app/ar`) a link to another
 * public page points at its Arabic twin (`/pricing` → `/ar/pricing`), so a visitor — and a crawler
 * reading the prerendered HTML — stays in Arabic; sign-in, the app, articles, anchors and other
 * origins are left as written. On every other page it is `next/link` unchanged.
 */
export function WebLink({ href, ...rest }: ComponentProps<typeof Link>) {
  const arabic = useRouteLocale() !== undefined;
  const target = arabic && typeof href === 'string' ? localizeHref(href) : href;
  return <Link href={target} {...rest} />;
}

export default WebLink;
