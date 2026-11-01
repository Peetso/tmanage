'use client';

import { use } from 'react';
import { DocumentPrintScreen } from '../../../../../components/screens/DocumentPrintScreen';

/**
 * **R5 PDF export — print view.** Opened in a new tab from the document's Export menu; prints
 * itself once the document has loaded. Same 404-not-403 read as the document view.
 */
export default function DocumentPrintPage({
  params,
}: {
  params: Promise<{ orgSlug: string; documentId: string }>;
}) {
  const { orgSlug, documentId } = use(params);
  return <DocumentPrintScreen organizationSlug={orgSlug} documentId={documentId} />;
}
