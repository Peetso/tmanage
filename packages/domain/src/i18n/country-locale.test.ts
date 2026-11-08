import { describe, expect, it } from 'vitest';
import { localeForAcceptLanguage as fromHeader, localeForCountry } from './country-locale.js';

describe('R12 country → locale', () => {
  it('maps unambiguous countries and leaves multilingual ones to the browser', () => {
    const mapped = 'MX fr AO AT CN SA EG IE US'.split(' ').map(localeForCountry).join();
    expect(mapped).toBe('es-ES,fr-FR,pt-BR,de-DE,zh-CN,ar-EG,ar-EG,en-GB,en-US');
    expect('CH BE CA LU SG HK TW JP'.split(' ').filter(localeForCountry)).toEqual([]);
  });

  it('reads Accept-Language in q order', () => {
    const headers = [
      'ja;q=1, zh-TW;q=0.8, de;q=0.9',
      'zh-HK,pt-PT;q=0.5',
      'pt-PT',
      'en-AU',
      'ja, *;q=0.1',
    ];
    expect(headers.map(fromHeader)).toEqual(['de-DE', 'zh-CN', 'pt-BR', 'en-GB', null]);
  });

  it('54-21: suggests Urdu from the browser only, never from the country', () => {
    expect(fromHeader('ur-PK,en;q=0.5')).toBe('ur-PK');
    expect(localeForCountry('PK')).toBeNull();
  });
});
