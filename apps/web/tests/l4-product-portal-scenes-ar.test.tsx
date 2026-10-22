import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientPortalPage } from '../src/components/website/pages/client-portal/ClientPortalPage';
import { ProductPage } from '../src/components/website/pages/product/ProductPage';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * Slice L4 (live check 014a9d51, report lines 59, 154, 155). In Arabic the /product mock-ups and
 * the /client-portal scenes were still English although the page promises every screen is
 * mirrored. Every scene string is now a catalog key; only product and company names, version
 * tags, ids and the portal URL stay Latin. The bilingual card on /product is the one deliberate
 * exception — it shows an English card beside an Arabic one in either locale — so it is skipped.
 */

const RLM = '‏';
const HERE = dirname(fileURLToPath(import.meta.url));

/** Latin that may legitimately remain inside an Arabic scene. */
const ALLOWED_LATIN =
  /atlas\.tmanage\.app\/portal|#atlas-relaunch|TManage|Northstar Studio|Northstar|Atlas Hospitality|Atlas|TM-1042|PDF|\bv\d\b/g;

function leftoverLatin(text: string): string[] {
  return text.replace(ALLOWED_LATIN, ' ').match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
}

function sceneTexts(container: HTMLElement): { label: string; text: string }[] {
  const scenes = [
    ...container.querySelectorAll<HTMLElement>('.tm-pp-scene:not(.tm-pp-scene--bilingual)'),
    ...container.querySelectorAll<HTMLElement>('.tm-cp-scene'),
  ];
  const peeks = [...container.querySelectorAll<HTMLElement>('.tm-cp-peek')];
  return [
    ...scenes.map((scene) => ({ label: scene.className, text: scene.textContent ?? '' })),
    ...peeks.map((peek) => ({ label: 'tm-cp-peek', text: peek.textContent ?? '' })),
  ];
}

afterEach(() => activeLocale.set('en-US'));

describe('L4 product and client-portal scenes in Arabic', () => {
  it('/product: the four mock-ups and their captions carry no English', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <ProductPage />
      </div>,
    );
    const scenes = sceneTexts(container);
    expect(scenes.length).toBeGreaterThanOrEqual(5);
    for (const scene of scenes) {
      expect(leftoverLatin(scene.text), scene.label).toEqual([]);
    }
    expect(container.textContent).toContain('مخاطر التسليم');
    expect(container.textContent).toContain('إعادة إطلاق موقع Atlas');
    expect(container.textContent).not.toContain('Preview as client');
  });

  it('/client-portal: preview, approval and requests cards carry no English', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <ClientPortalPage />
      </div>,
    );
    const scenes = sceneTexts(container);
    expect(scenes.length).toBeGreaterThanOrEqual(4);
    for (const scene of scenes) {
      expect(leftoverLatin(scene.text), scene.label).toEqual([]);
    }
    // An Arabic line that opens with Latin names starts with U+200F so it stays right-to-left.
    const org = container.querySelector('.tm-cp-scene--overview .tm-web-scene__mono');
    expect(org?.textContent?.startsWith(RLM)).toBe(true);
    expect(container.textContent).toContain('اعتماد v2');
    expect(container.textContent).not.toContain('Ask Northstar for something');
  });

  it('English stays English', () => {
    const { container } = render(<ClientPortalPage />);
    expect(container.textContent).toContain('Ask Northstar for something…');
    expect(container.textContent).toContain('Approve v2');
  });

  it('the app-shell grid can shrink its work column, so the details panel is never clipped', () => {
    const css = readFileSync(
      join(HERE, '../src/components/website/pages/product/product.css'),
      'utf8',
    );
    const shell = /\.tm-pp-shell \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(shell).toContain('minmax(0, 1fr)');
    expect(shell).not.toMatch(/minmax\(calc/);
  });
});
