import { describe, expect, it } from 'vitest';
import {
  CollabRefusal,
  DocumentCollabAuthority,
  SESSION_IDLE_MS,
} from './document-collab.authority.js';

const step = (n: number) => ({ stepType: 'replace', from: n, to: n });

describe('DocumentCollabAuthority (53-10)', () => {
  it('accepts steps on the newest version and refuses a stale version', () => {
    const a = new DocumentCollabAuthority();
    expect(a.push('o:d', 0, 'c1', [step(1), step(2)])).toEqual({ accepted: true, version: 2 });
    expect(a.push('o:d', 0, 'c2', [step(3)])).toEqual({ accepted: false, version: 2 });
    expect(a.since('o:d', 0)).toMatchObject({ kind: 'steps', version: 2 });
    expect(a.since('o:d', 1)).toMatchObject({ steps: [{ step: step(2), clientId: 'c1' }] });
  });

  it('refuses malformed steps', () => {
    const a = new DocumentCollabAuthority();
    expect(() => a.push('o:d', 0, 'c1', [{ nope: 1 }])).toThrow(CollabRefusal);
    expect(() => a.push('o:d', 0, 'c1', [])).toThrow(CollabRefusal);
  });

  it('a snapshot at the newest version becomes the base; far-behind pollers must resync', () => {
    const a = new DocumentCollabAuthority();
    a.push('o:d', 0, 'c1', [step(1)]);
    expect(a.snapshot('o:d', 0, '<p>old</p>')).toBe(false);
    expect(a.snapshot('o:d', 1, '<p>x</p>')).toBe(true);
    expect(a.join('o:d', 'u1')).toEqual(
      expect.objectContaining({ version: 1, baseVersion: 1, baseHtml: '<p>x</p>', steps: [] }),
    );
    expect(a.since('o:d', 0)).toMatchObject({ kind: 'steps', version: 1 });
    expect(a.since('o:d', 5)).toEqual({ kind: 'resync', version: 1 });
    const many = Array.from({ length: 200 }, (_, i) => step(i));
    for (let v = 1; v < 1 + 200 * 3; v += 200) a.push('o:d', v, 'c1', many);
    expect(a.snapshot('o:d', 601, '<p>y</p>')).toBe(true);
    expect(a.since('o:d', 1)).toEqual({ kind: 'resync', version: 601 });
    expect(a.since('o:d', 101)).toMatchObject({ kind: 'steps' });
  });

  it('gives each member a stable colour and drops idle sessions', () => {
    let clock = 0;
    const a = new DocumentCollabAuthority(() => clock);
    expect(a.join('o:d', 'u1').colour).toBe(0);
    expect(a.join('o:d', 'u2').colour).toBe(1);
    expect(a.join('o:d', 'u1').colour).toBe(0);
    a.push('o:d', 0, 'c1', [step(1)]);
    clock = SESSION_IDLE_MS + 1;
    expect(a.join('o:x', 'u1').version).toBe(0);
    expect(a.join('o:d', 'u1').version).toBe(0);
  });
});
