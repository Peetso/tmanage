import { HELP_ARTICLES, findHelpCategory, type HelpArticle, type HelpBlock } from './help-articles';

/**
 * Row 55-16 — client-side help search. Runs in the browser over the repo content, in both
 * languages at once, so a reader on the Arabic page who types an English word still finds it.
 *
 * Arabic is normalised before matching: diacritics (tashkeel) and tatweel are dropped, the alef
 * forms (أ إ آ ٱ) fold to ا, ى to ي, ة to ه, ؤ to و, ئ to ي, and Arabic-Indic digits become 0–9.
 * A leading "ال" is also ignored on each word, so "المهام" and "مهام" meet.
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const FOLDS: Readonly<Record<string, string>> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ى: 'ي',
  ة: 'ه',
  ؤ: 'و',
  ئ: 'ي',
};

export function normaliseForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱىةؤئ]/g, (c) => FOLDS[c] ?? c)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The words of a query, each without a leading Arabic article "ال" when the rest is long enough. */
export function searchTerms(query: string): string[] {
  return normaliseForSearch(query)
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => (w.startsWith('ال') && w.length > 3 ? w.slice(2) : w));
}

function blockText(block: HelpBlock): string {
  return block.kind === 'steps' ? block.items.join(' ') : block.text;
}

interface Indexed {
  article: HelpArticle;
  title: string;
  rest: string;
}

const INDEX: readonly Indexed[] = HELP_ARTICLES.map((article) => {
  const category = findHelpCategory(article.category);
  return {
    article,
    title: normaliseForSearch(`${article.en.title} ${article.ar.title}`),
    rest: normaliseForSearch(
      [
        article.en.summary,
        article.ar.summary,
        category.title.en,
        category.title.ar,
        ...(article.en.keywords ?? []),
        ...(article.ar.keywords ?? []),
        ...article.en.body.map(blockText),
        ...article.ar.body.map(blockText),
      ].join(' '),
    ),
  };
});

/**
 * The articles that contain every word of `query`, best first: a title hit outweighs a body hit.
 * An empty query returns nothing — the index shows its categories instead.
 */
export function searchHelp(query: string): HelpArticle[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const scored: { article: HelpArticle; score: number; order: number }[] = [];
  INDEX.forEach((entry, order) => {
    let score = 0;
    for (const term of terms) {
      if (entry.title.includes(term)) score += 3;
      else if (entry.rest.includes(term)) score += 1;
      else return;
    }
    scored.push({ article: entry.article, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.article);
}
