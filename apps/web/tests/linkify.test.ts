import { describe, expect, it } from 'vitest';
import { firstLink, splitLinks } from '../src/lib/linkify';

describe('splitLinks', () => {
  it('links only http(s) URLs, keeps trailing punctuation and truncated URLs as text', () => {
    const segments = splitLinks(
      'See https://github.com/a/b. Not javascript:alert(1) or https://x.io/cut…',
    );
    expect(segments).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://github.com/a/b', href: 'https://github.com/a/b' },
      { kind: 'text', text: '. Not javascript:alert(1) or https://x.io/cut…' },
    ]);
    expect(firstLink('no links here')).toBeNull();
  });
});
