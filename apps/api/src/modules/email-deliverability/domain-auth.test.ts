import { describe, expect, it } from 'vitest';
import { checkDomainAuth, parseDmarc, parseSpf } from './domain-auth.js';

const KEY = 'A'.repeat(392);

describe('51-11 DNS reader', () => {
  it('parses SPF and DMARC policy state', () => {
    expect(parseSpf(['v=spf1 include:_spf.mail.hostinger.com ~all']).status).toBe('pass');
    expect(parseSpf(['v=spf1 +all']).status).toBe('invalid');
    expect(parseSpf(['v=spf1 a ~all', 'v=spf1 mx ~all']).status).toBe('invalid');
    expect(parseDmarc(['v=DMARC1; p=none; rua=mailto:x@y.z']).policy).toBe('none');
    expect(parseDmarc(['v=DMARC1; p=reject']).status).toBe('pass');
    expect(parseDmarc(null).status).toBe('missing');
  });

  it('reads all three records and never throws on a missing name', async () => {
    const zone: Record<string, string[][]> = {
      'peetrix.com': [['v=spf1 include:_spf.mail.hostinger.com -all']],
      'hostingermail-b._domainkey.peetrix.com': [['v=DKIM1; k=rsa; p=', KEY]],
      '_dmarc.peetrix.com': [['v=DMARC1; p=quarantine; rua=mailto:d@peetrix.com']],
    };
    const resolver = (name: string): Promise<string[][]> =>
      zone[name] === undefined
        ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }))
        : Promise.resolve(zone[name]);
    const report = await checkDomainAuth('peetrix.com', { resolver });
    expect(report.overall).toBe('pass');
    expect(report.dkim.selector).toBe('hostingermail-b');
    const empty = await checkDomainAuth('nothing.test', { resolver });
    expect(empty.overall).toBe('fail');
  });
});
