import { describe, expect, it } from 'vitest';
import { xmlHash } from '@tmanage/domain';
import { GENESIS_PIH, chainLink, twoPlaces } from './einvoice-rules.js';

/** 52-12 (R21-d): the chain link rule — first icv 1 / pih sha256('0'), then previous hash. */
describe('52-12 einvoice chain', () => {
  it('starts at icv 1 with the genesis PIH and links the next to the previous XML hash', () => {
    expect(GENESIS_PIH).toBe('5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9');
    const first = chainLink(null, (p) => `<x icv="${String(p.icv)}" pih="${p.pih}"/>`);
    expect(first).toMatchObject({ icv: 1, pih: GENESIS_PIH, xmlHash: xmlHash(first.xml) });
    const second = chainLink(first, (p) => `<x icv="${String(p.icv)}" pih="${p.pih}"/>`);
    expect(second).toMatchObject({ icv: 2, pih: first.xmlHash });
    expect(second.xmlHash).not.toBe(first.xmlHash);
    expect(twoPlaces(1_150_000, 'KWD')).toBe('1150.00');
  });
});
