import { describe, expect, it } from 'vitest';
import en from './email/en.json' with { type: 'json' };
import ar from './email/ar.json' with { type: 'json' };
import ur from './email/ur.json' with { type: 'json' };
import { emailCatalogOf, emailIsRtl, emailLocale, emailT } from './email-messages.js';

describe('emailT (R12 R2)', () => {
  it('picks the catalog by language, fills placeholders and falls back to English', () => {
    expect(emailCatalogOf('pt-PT')).toBe('pt-BR');
    expect(emailCatalogOf('ja-JP')).toBe('en');
    expect(emailT('ar-EG', 'welcome.subject')).toBe(ar['welcome.subject']);
    expect(emailT('xx', 'passwordReset.heading', { name: 'Mona' })).toBe(
      'Hi Mona, choose a new password',
    );
    expect(emailIsRtl('ar-SA')).toBe(true);
    expect(emailIsRtl('es-ES')).toBe(false);
  });

  it('prefers the person, then the workspace, then English', () => {
    expect(emailLocale('de-DE', 'fr-FR')).toBe('de-DE');
    expect(emailLocale(null, 'fr-FR')).toBe('fr-FR');
    expect(emailLocale(undefined, null)).toBe('en');
  });

  it('keeps the Arabic email catalog in step with English', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });

  it('sends Urdu mail from a complete right-to-left Urdu catalog (SMALLFIX 2)', () => {
    expect(emailCatalogOf('ur-PK')).toBe('ur');
    expect(emailIsRtl('ur-PK')).toBe(true);
    expect(emailT('ur-PK', 'emailConfirm.button')).toBe(ur['emailConfirm.button']);
    expect(Object.keys(ur).sort()).toEqual(Object.keys(en).sort());
  });
});
