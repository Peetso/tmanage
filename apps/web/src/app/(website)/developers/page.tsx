import type { Metadata } from 'next';
import { DevelopersPage } from '../../../components/website/pages/developers/DevelopersPage';
import { buildApiReference } from '../../../components/website/pages/developers/api-reference';
import { DEV_COPY } from '../../../components/website/pages/developers/developers-copy';
import openapiSnapshot from '../../../content/developers/openapi-snapshot.json';

export const metadata: Metadata = {
  title: 'Developers',
  description: DEV_COPY.lede,
};

/**
 * 54-04 — the public developer portal, routed at `/developers` (Arabic twin `/ar/developers`).
 * The API reference is built here, at build time, from the committed product contract
 * (`scripts/sync-openapi-snapshot.mjs` → `openapi-snapshot.json`).
 */
export default function DevelopersRoute() {
  return <DevelopersPage reference={buildApiReference(openapiSnapshot)} />;
}
