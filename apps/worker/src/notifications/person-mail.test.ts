import { describe, expect, it } from 'vitest';
import { SIGNATURE_TOKENS } from '@tmanage/mail';
import { PERSON_MAIL_CATALOG } from './person-mail-catalog.js';
import { composePersonMail } from './person-mail.js';

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
