import { describe, expect, it } from 'vitest';
import { SIGNATURE_TOKENS } from '@tmanage/mail';
import { PERSON_MAIL_CATALOG, newsKind } from './person-mail-catalog.js';
import { arabicPublicLink, composePersonMail } from './person-mail.js';

const context = {
  to: 'sara@example.test',
  displayName: 'Sara Hassan',
  workspaceName: 'Nile Studio',
  slug: 'nile',
  webOrigin: 'https://tmanageapp.com',
  organizationId: 'org-1',
  userId: 'user-1',
  count: 3,
} as const;

describe('composePersonMail', () => {
  it('sends the HTML card with the button and signature, and keeps the plain-text fallback', () => {
    const kind = PERSON_MAIL_CATALOG[0];
    if (kind === undefined) throw new Error('empty catalog');
    const mail = composePersonMail(kind, { ...context, language: 'ar' });
    expect(mail.text).toContain('https://tmanageapp.com/nile');
    expect(mail.html).toContain('<html lang="ar" dir="rtl">');
    expect(mail.html).toContain('href="https://tmanageapp.com/nile');
    expect(mail.html).toContain(SIGNATURE_TOKENS.by);
    expect(mail.html).toContain(SIGNATURE_TOKENS.note);
    expect(mail.html).toContain('مرحبًا Sara،');
  });
});

describe('MAILREST — Arabic Feature news links to the Arabic page', () => {
  const note = (link: string) =>
    newsKind({
      id: '0b3f2a6e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
      titleEn: 'Timers',
      titleAr: 'المؤقتات',
      bodyEn: 'Start a timer from any task.',
      bodyAr: 'شغّل مؤقتًا من أي مهمة.',
      link,
    });

  it('sends Arabic readers to the /ar twin and English readers to the page as written', () => {
    const kind = note('https://tmanageapp.com/changelog#timers');
    const ar = composePersonMail(kind, { ...context, language: 'ar' });
    const en = composePersonMail(kind, { ...context, language: 'en' });
    expect(ar.text).toContain('https://tmanageapp.com/ar/changelog#timers');
    expect(ar.html).toContain('href="https://tmanageapp.com/ar/changelog#timers"');
    expect(en.text).toContain('https://tmanageapp.com/changelog#timers');
    expect(en.text).not.toContain('/ar/');
  });

  it('rewrites only TManage pages that have an Arabic twin', () => {
    const origin = 'https://tmanageapp.com';
    expect(arabicPublicLink('https://tmanageapp.com/', origin)).toBe('https://tmanageapp.com/ar');
    expect(arabicPublicLink('https://www.tmanageapp.com/help/timers', origin)).toBe(
      'https://www.tmanageapp.com/ar/help/timers',
    );
    expect(arabicPublicLink('https://tmanageapp.com/ar/pricing', origin)).toBe(
      'https://tmanageapp.com/ar/pricing',
    );
    // No Arabic twin, someone else's site, or not https: unchanged.
    expect(arabicPublicLink('https://tmanageapp.com/blog/x', origin)).toBe(
      'https://tmanageapp.com/blog/x',
    );
    expect(arabicPublicLink('https://example.com/changelog', origin)).toBe(
      'https://example.com/changelog',
    );
    expect(arabicPublicLink('https://app.example.test/pricing', 'https://app.example.test')).toBe(
      'https://app.example.test/ar/pricing',
    );
  });

  it('leaves an in-app link to the workspace path', () => {
    const ar = composePersonMail(note('/work'), { ...context, language: 'ar' });
    expect(ar.text).toContain('https://tmanageapp.com/nile/work');
  });
});
