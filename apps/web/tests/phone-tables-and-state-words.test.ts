import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import { AA_NORMAL_TEXT, colorLight, contrastRatio } from '@tmanage/ui';
import { afterEach, describe, expect, it } from 'vitest';
import ar from '../src/lib/i18n/messages/ar.json';
import en from '../src/lib/i18n/messages/en.json';
import { activeLocale, DEFAULT_LOCALE } from '../src/lib/i18n/locale-store';
import { stateLabel } from '../src/lib/work-item-presentation';

/**
 * ACT-11 / NFR-02 leftovers (lane C8): the work-state words in Arabic, the phone tables, and the
 * overdue date on the work list that was warning-600 text.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(HERE, path), 'utf8');
const PHONE_CSS = read('../src/styles/phone-tables.css');
const LAYOUT = read('../src/app/layout.tsx');
const WORK_CORE_CSS = read('../src/components/screens/work-core.css');

/** The body of the first `@media (max-width: 767px)` block, braces balanced. */
function phoneBlock(css: string): string {
  const start = css.indexOf('@media (max-width: 767px)');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  throw new Error('unbalanced @media block');
}

/** The declarations of `selector` inside `css` (first match). */
function declarations(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

afterEach(() => {
  activeLocale.set(DEFAULT_LOCALE);
});

describe('work-state words follow the active language', () => {
  it('says "Blocked" in English and the catalog word in Arabic', () => {
    expect(stateLabel('blocked', 'en-US')).toBe('Blocked');
    expect(stateLabel('blocked', 'ar-EG')).toBe(ar['WorkListScreen.stateBlocked']);
    expect(stateLabel('blocked', 'ar-EG')).not.toBe('Blocked');
  });

  it('has an Arabic word for every state, the same one the filter chip shows', () => {
    for (const state of WORK_ITEM_STATES) {
      const word = stateLabel(state, 'ar-EG');
      expect(word, state).toMatch(/[؀-ۿ]/u);
      expect(word, state).not.toMatch(/[A-Za-z]/u);
      expect(stateLabel(state, 'en-US'), state).toMatch(/^[A-Z]/u);
    }
    expect(Object.keys(en)).toEqual(expect.arrayContaining(['WorkListScreen.stateArchived']));
  });

  it('reads the active locale when no locale is passed (plain call sites in every work screen)', () => {
    expect(stateLabel('done')).toBe('Done');
    activeLocale.set('ar-EG');
    expect(stateLabel('done')).toBe(ar['WorkListScreen.stateDone']);
  });
});

describe('phone tables become card rows or scroll inside their card (ACT-11)', () => {
  const block = phoneBlock(PHONE_CSS);

  it('is loaded on every route', () => {
    expect(LAYOUT).toMatch(/import '\.\.\/styles\/phone-tables\.css';/u);
  });

  it('turns work list rows into wrapped card rows with the title on its own line', () => {
    expect(declarations(block, '  .tm-wk-table-frame .tm-wk-table tr')).toMatch(/display: flex/u);
    expect(declarations(block, '  .tm-wk-table-frame .tm-wk-table tr')).toMatch(/flex-wrap: wrap/u);
    expect(declarations(block, '  .tm-wk-table-frame .tm-wk-table .tm-table__title')).toMatch(
      /flex: 1 0 100%/u,
    );
  });

  it('turns docs rows into card rows and keeps the column names for screen readers only', () => {
    expect(declarations(block, '  .tm-dx-table-card .tm-dx-table tbody tr')).toMatch(
      /display: flex/u,
    );
    const head = declarations(block, '  .tm-dx-table-card .tm-dx-table thead');
    expect(head).toMatch(/clip-path: inset\(50%\)/u);
    expect(head).not.toMatch(/display: none/u);
  });

  it('lets every other table card scroll sideways instead of clipping', () => {
    expect(block).toMatch(/\.tm-cc-card\.tm-cc-card--flush:has\(table\)/u);
    expect(block).toMatch(/\.tm-ins-card\.tm-ins-card--table:has\(table\)/u);
    expect(block).toMatch(/overflow-x: auto/u);
  });

  it('mirrors the selected-row bar in Arabic and uses tokens only', () => {
    expect(block).toMatch(/\[dir='rtl'\] \.tm-wk-table-frame/u);
    expect(block).toMatch(/\[dir='rtl'\] \.tm-dx-table-card/u);
    expect(PHONE_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu);
  });
});

describe('the overdue / stale date on the work list meets AA', () => {
  it('keeps the figures ink and moves the warning tone to an underline', () => {
    const rule = declarations(WORK_CORE_CSS, ".tm-wk-mono[data-tone='warning']");
    expect(rule).not.toMatch(/(^|[^-])color: var\(--warning-600\)/u);
    expect(rule).toMatch(/color: var\(--tm-on-tone\)/u);
    expect(rule).toMatch(/var\(--warning-600\)/u);
  });

  it('was a real failure: warning-600 on paper is under AA, ink-800 is well over', () => {
    expect(contrastRatio(colorLight.warning['600'], colorLight.paper['0'])).toBeLessThan(
      AA_NORMAL_TEXT,
    );
    expect(contrastRatio(colorLight.ink['800'], colorLight.paper['0'])).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });
});
