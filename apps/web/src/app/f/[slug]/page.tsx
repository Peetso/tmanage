'use client';

import { use } from 'react';
import { PublicFormScreen } from '../../../components/screens/PublicFormScreen';

/**
 * 2026-10-31 live-test fix — the public page of a shared intake form. The API has answered
 * `/v1/public/forms/<slug>` since 52-20, but the web app had no page here, so a published link
 * opened "We couldn't find that page". No session is needed; nothing here is tenant-scoped.
 */
export default function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return <PublicFormScreen slug={slug} />;
}
