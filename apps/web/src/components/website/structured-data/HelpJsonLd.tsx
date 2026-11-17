import { findHelpArticle, findHelpCategory } from '../../../content/help/help-articles';
import { helpCopy } from '../../../content/help/help-copy';
import { breadcrumbList, howTo, type JsonLd } from '../../../lib/structured-data';
import { JsonLdScript, pageContext, type PageContext, type PageFamilyProps } from './page-context';

function helpData(context: PageContext): JsonLd[] {
  const found = findHelpArticle(context.english.slice('/help/'.length));
  if (found === undefined) return [];
  const copy = helpCopy(context.language);
  const category = findHelpCategory(found.category);
  const text = found[context.language];
  const url = context.url(context.english);
  const steps = text.body.flatMap((block) => (block.kind === 'steps' ? block.items : []));
  return [
    breadcrumbList([
      { name: copy.home, url: context.url('/help') },
      {
        name: category.title[context.language],
        url: `${context.url('/help')}#topic-${category.id}`,
      },
      { name: text.title, url },
    ]),
    ...(steps.length === 0
      ? []
      : [howTo({ language: context.language, url, name: text.title, steps })]),
  ];
}

/** A help article (`/help/<slug>`): its breadcrumb trail, and its numbered steps as a HowTo. */
export function HelpJsonLd({ english, language }: PageFamilyProps) {
  return <JsonLdScript items={helpData(pageContext(english, language))} />;
}
