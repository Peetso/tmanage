import { article, breadcrumbList, type JsonLd } from '../../../lib/structured-data';
import { findResource } from '../pages/resources/resources-data';
import { JsonLdScript, pageContext, type PageContext, type PageFamilyProps } from './page-context';

function resourceData(context: PageContext): JsonLd[] {
  const item = findResource(context.english.slice('/resources/'.length));
  if (item === undefined) return [];
  const url = context.url(context.english);
  const headline = context.t(item.titleKey);
  return [
    breadcrumbList([
      { name: context.t('ResourceArticlePage.resources'), url: context.url('/resources') },
      { name: headline, url },
    ]),
    article({
      language: context.language,
      url,
      headline,
      description: context.t(item.lineKey),
    }),
  ];
}

/** A library article (`/resources/<slug>`): its breadcrumb trail and the Article itself. */
export function ResourceJsonLd({ english, language }: PageFamilyProps) {
  return <JsonLdScript items={resourceData(pageContext(english, language))} />;
}
