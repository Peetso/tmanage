import { catalogPartResponse } from '../../../lib/i18n/catalog-part-response';

/** CATSPLIT: one part of one language's catalog, for the browser (`lib/i18n/catalogs-lazy.ts`). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ catalog: string }> },
): Promise<Response> {
  const { catalog } = await params;
  return catalogPartResponse(catalog, new URL(request.url).searchParams.get('v'));
}
