import { describe, expect, it } from 'vitest';
import { embedSrc, isEmbeddableUrl } from '../src/components/docs/editor/schema-extensions';
import { buildContentSecurityPolicy } from '../src/lib/csp';

/**
 * FIX2 item 9: the doc editor built YouTube/Vimeo iframes, but the enforced policy named no video
 * host, so every video embed was a blocked frame; Loom (the agencies' screen recordings) was not
 * embeddable at all.
 */
describe('doc video embeds', () => {
  it('embeds a Loom share link', () => {
    const share = 'https://www.loom.com/share/0123456789abcdef0123456789abcdef';
    expect(isEmbeddableUrl(share)).toBe(true);
    expect(embedSrc(share)).toBe('https://www.loom.com/embed/0123456789abcdef0123456789abcdef');
    expect(embedSrc('https://www.loom.com/looms/videos')).toBeNull();
  });

  it('lets the video hosts frame, and nothing more', () => {
    const policy = buildContentSecurityPolicy({
      nonce: 'abc123==',
      host: 'tmanage.peetrix.com',
      development: false,
    });
    const frames = /frame-src[^;]*/u.exec(policy)?.[0] ?? '';
    for (const host of [
      'https://www.youtube.com',
      'https://player.vimeo.com',
      'https://www.loom.com',
    ]) {
      expect(frames).toContain(host);
    }
    const scripts = /script-src[^;]*/u.exec(policy)?.[0] ?? '';
    expect(scripts).not.toMatch(/youtube|vimeo|loom/u);
  });
});
