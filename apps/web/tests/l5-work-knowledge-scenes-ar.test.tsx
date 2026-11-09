import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturesKnowledgePage } from '../src/components/website/pages/features-knowledge/FeaturesKnowledgePage';
import { FeaturesWorkPage } from '../src/components/website/pages/features-work/FeaturesWorkPage';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';

/**
 * Slice L5 (live check 014a9d51, REPORT lines 43 and 52): the product mock-ups on /features/work
 * and /features/knowledge read Arabic on the Arabic page. Names, IDs and version tags stay Latin;
 * every other Latin word inside a scene is a string that missed the catalog.
 */

/** Latin that is meant to stay Latin inside an Arabic scene. Longest first. */
const KEEP_LATIN = [
  // The mock browser's address, split by a <wbr>.
  'tmanage.app / atlas / docs /',
  'homepage-direction',
  'Atlas Website Relaunch',
  'Atlas Hospitality',
  'Northstar Studio',
  'faq-arabic-v2.docx',
  '#atlas-relaunch',
  'Youssef Kamal',
  'Maya Hassan',
  'Lina Samir',
  'Salma Riad',
  'Omar Adel',
  '8f2c·d41a',
  'TManage',
  'Youssef',
  'Salma',
  'Atlas',
  'Omar',
  'Lina',
  'TSK-1042',
  'REQ-64',
  'DEC-41',
  'DEC-29',
  'WK-12',
  'TSK',
  'DEL',
  'DEC',
  'REQ',
  'v2',
  'v3',
  '⌘K',
];

function strayLatin(root: ParentNode, selector: string): string[] {
  const stray: string[] = [];
  for (const node of root.querySelectorAll(selector)) {
    // Template previews take their steps from the page's own data, not from these scenes.
    if (node.closest('.tm-fw-scene--template')) continue;
    // Text node by text node, so neighbouring avatars do not run together ("YK" + "SR").
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let at = walker.nextNode(); at; at = walker.nextNode()) {
      let text = at.textContent ?? '';
      for (const keep of KEEP_LATIN) text = text.split(keep).join(' ');
      // Initials discs (OA, LS, NF…) are two capitals standing alone.
      text = text.replace(/\b[A-Z]{2}\b/g, ' ');
      stray.push(...(text.match(/[A-Za-z]{2,}/g) ?? []));
    }
  }
  return stray;
}

afterEach(() => activeLocale.set('en-US'));

describe('L5 · Work and Knowledge scenes in Arabic', () => {
  it('the Work page scenes carry no English in ar-EG', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <FeaturesWorkPage />
      </div>,
    );
    expect(container.querySelectorAll('.tm-fw-scene__body').length).toBeGreaterThan(5);
    expect(strayLatin(container, '.tm-fw-scene__body')).toEqual([]);
    expect(strayLatin(container, '.tm-fw-scene > figcaption')).toEqual([]);
  });

  it('the Knowledge page scenes carry no English in ar-EG', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <FeaturesKnowledgePage />
      </div>,
    );
    expect(container.querySelectorAll('.tm-fk-scene__body').length).toBeGreaterThan(5);
    expect(strayLatin(container, '.tm-fk-scene__body')).toEqual([]);
    expect(strayLatin(container, '.tm-fk-scene > figcaption')).toEqual([]);
    expect(container.textContent).toContain('هذا الاعتماد لم يعد ساريًا');
  });

  it('the keyboard-move sentence on the board is in both catalogs', () => {
    const key = 'FeaturesWorkScenes.board.moving' as MessageKey;
    expect(translate('en-US', key)).toBe('Moving “{title}” — column {column} of {total}');
    const arabic = translate('ar-EG', key);
    expect(arabic).not.toBe(key);
    expect(arabic).toMatch(/[؀-ۿ]/);
    expect(arabic).toContain('{title}');
  });

  it('the English page keeps the design copy', () => {
    const { container } = render(<FeaturesWorkPage />);
    expect(container.textContent).toContain(
      'Moving “Prepare mobile booking flow concepts” — column 3 of 12',
    );
    expect(container.textContent).toContain('committed 20 Aug · forecast 25 Aug');
    const knowledge = render(<FeaturesKnowledgePage />);
    expect(knowledge.container.textContent).toContain('Request review of v3');
    expect(knowledge.container.textContent).toContain('13 Aug 09:12');
  });
});
