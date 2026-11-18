import { describe, expect, it } from 'vitest';
import { isFreeMailDomain, suggestWorkspaceName } from '../src/lib/workspace-name-suggestion';

describe('suggestWorkspaceName', () => {
  it.each([
    ['omar@northstar.studio', 'Northstar Studio'],
    ['sara@acme.com', 'Acme'],
    ['sara@mail.acme.co.uk', 'Acme'],
    ['team@blue-fig.io', 'Blue Fig'],
    ['ali@nile.com.eg', 'Nile'],
  ])('names a company address after its domain: %s', (email, expected) => {
    expect(suggestWorkspaceName(email, 'Anyone')).toBe(expected);
  });

  it.each(['mona@gmail.com', 'mona@outlook.com', 'mona@yahoo.co.uk', 'mona@icloud.com'])(
    'names a free-mail address after the person: %s',
    (email) => {
      expect(suggestWorkspaceName(email, '  Mona   Adel ')).toBe('Mona Adel');
      expect(suggestWorkspaceName(email, '')).toBe('');
    },
  );

  // TESTUX P2 28: "nadia@cedarlogistics1731.example" suggested "Cedarlogistics1731 Example".
  it.each([
    ['nadia@cedarlogistics1731.example', 'Cedarlogistics'],
    ['nadia@cedar-logistics-20261118.test', 'Cedar Logistics'],
    ['nadia@studio42.agency', 'Studio42 Agency'],
  ])('drops reserved test endings and a long number run: %s', (email, expected) => {
    expect(suggestWorkspaceName(email, 'Nadia Karim')).toBe(expected);
  });

  it('falls back to the name when only a number is left', () => {
    expect(suggestWorkspaceName('nadia@20261118.example', 'Nadia Karim')).toBe('Nadia Karim');
  });

  it('falls back to the name when the address has no usable domain', () => {
    expect(suggestWorkspaceName('not-an-email', 'Mona Adel')).toBe('Mona Adel');
    expect(suggestWorkspaceName('mona@localhost', 'Mona Adel')).toBe('Mona Adel');
  });

  it('knows the free providers by domain and by brand', () => {
    expect(isFreeMailDomain('GMAIL.com')).toBe(true);
    expect(isFreeMailDomain('hotmail.fr')).toBe(true);
    expect(isFreeMailDomain('northstar.studio')).toBe(false);
  });
});
