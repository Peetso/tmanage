import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeFormProof, formProofFields } from '../src/lib/form-proof';

describe('52-21 form proof (browser half)', () => {
  it('computes the lower-case hex SHA-256 of nonce + startedAt the server recomputes', async () => {
    const expected = createHash('sha256')
      .update('n0nce' + 'tok.sig')
      .digest('hex');
    expect(await computeFormProof('n0nce', 'tok.sig')).toBe(expected);
    expect(await formProofFields({ nonce: 'n0nce', startedAt: 'tok.sig' })).toEqual({
      nonce: 'n0nce',
      startedAt: 'tok.sig',
      proof: expected,
    });
  });

  it('sends no proof fields when none could be fetched', async () => {
    expect(await formProofFields(null)).toEqual({});
  });
});
