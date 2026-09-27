'use client';

import { use } from 'react';
import { MarketingResourceScreen } from '../../../components/screens/MarketingResourceScreen';

/**
 * **Public resource / guide article** — Public & trust site, module 1 (x187).
 *
 * A top-level, tenant-free route (`/resources/[slug]`): the slug names one article in the public
 * library and is handed to {@link MarketingResourceScreen}, which reads the `@Public()`
 * `GET /v1/public/site/resources/:slug`. A slug the API's fixed catalog does not name comes back a
 * 404 and the screen renders an honest "not found" with a way back to the index.
 */
export default function ResourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return <MarketingResourceScreen slug={slug} />;
}
