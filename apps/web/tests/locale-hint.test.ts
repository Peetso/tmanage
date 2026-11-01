import { beforeEach, describe, expect, it } from 'vitest';
import { offeredLocaleFor, resolveLocaleHint } from '../src/lib/i18n/locale-hint';
import { readLocaleSource } from '../src/lib/i18n/locale-source';
import { LocaleStore } from '../src/lib/i18n/locale-store';

/** R12 R2 — the first-visit guess: API, then browser languages, then en-US; a choice always wins. */
describe('locale hint', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    document.cookie = 'tmanage_locale=; Max-Age=0; Path=/';
  });

  it('falls back from the API to the browser languages to en-US', async () => {
    const fail = () => Promise.reject(new Error('404'));
    expect(
      await resolveLocaleHint(() => Promise.resolve({ locale: 'es-ES', source: 'geo' }), []),
    ).toEqual({ locale: 'es-ES', source: 'geo' });
    expect(await resolveLocaleHint(fail, ['zh-TW', 'pt-PT'])).toEqual({
      locale: 'pt-BR',
      source: 'browser',
    });
    expect(await resolveLocaleHint(fail, ['ja-JP'])).toEqual({
      locale: 'en-US',
      source: 'default',
    });
    expect(offeredLocaleFor('en-gb')).toBe('en-GB');
  });

  it('applies once with source auto, and never over a choice', () => {
    const store = new LocaleStore();
    expect(store.applyHint('fr-FR')).toBe(true);
    expect(store.get()).toBe('fr-FR');
    expect(readLocaleSource()).toBe('auto');
    expect(store.applyHint('de-DE')).toBe(false);

    globalThis.localStorage.clear();
    document.cookie = 'tmanage_locale=; Max-Age=0; Path=/';
    const chosen = new LocaleStore();
    chosen.set('en-GB');
    expect(chosen.applyHint('es-ES')).toBe(false);
    expect(readLocaleSource()).toBe('chosen');
  });
});
