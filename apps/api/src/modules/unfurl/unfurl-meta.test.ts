import { describe, expect, it } from 'vitest';
import { normaliseUnfurlUrl, oembedToCard, parseHtmlMeta, unfurlOpenUrl } from './unfurl-meta.js';

describe('normaliseUnfurlUrl', () => {
  it('accepts an exact allow-listed https host and drops the fragment, keeping the query', () => {
    expect(
      normaliseUnfurlUrl('https://www.figma.com/design/AbCdEfGhIj12/x?node-id=1-2#top'),
    ).toEqual({
      url: 'https://www.figma.com/design/AbCdEfGhIj12/x?node-id=1-2',
      provider: 'figma',
    });
    expect(normaliseUnfurlUrl('https://GitHub.com/acme/repo')).toMatchObject({
      provider: 'github',
    });
  });

  it.each([
    'http://github.com/acme/repo',
    'https://user:pw@github.com/acme',
    'https://github.com:8443/acme',
    'https://evil.figma.com/design/x',
    'https://figma.com.evil.net/design/x',
    'https://10.0.0.5/x',
  ])('refuses %s as host_not_allowed', (raw) => {
    expect(normaliseUnfurlUrl(raw)).toEqual({ reason: 'host_not_allowed' });
  });

  it('refuses garbage and over-long input as invalid_url', () => {
    expect(normaliseUnfurlUrl('not a url')).toEqual({ reason: 'invalid_url' });
    expect(normaliseUnfurlUrl(`https://github.com/${'a'.repeat(2100)}`)).toEqual({
      reason: 'invalid_url',
    });
  });
});

describe('parseHtmlMeta / oembedToCard', () => {
  it('reads og tags first, decodes entities, and keeps an https image only', () => {
    const html =
      '<head><title>Fallback</title><meta property="og:title" content="Repo &amp; things">' +
      `<meta content='A   repo' property='og:description'>` +
      '<meta property="og:image" content="http://x/i.png"></head>';
    expect(parseHtmlMeta(html)).toEqual({
      title: 'Repo & things',
      description: 'A repo',
      imageUrl: null,
    });
    expect(parseHtmlMeta('<title> Only\n title </title>').title).toBe('Only title');
  });

  it('keeps an https oEmbed thumbnail and nulls an http one', () => {
    expect(oembedToCard({ title: 'F', thumbnail_url: 'https://s3/t.png' })).toEqual({
      title: 'F',
      thumbnailUrl: 'https://s3/t.png',
    });
    expect(oembedToCard({ title: 'F', thumbnail_url: 'http://s3/t.png' })?.thumbnailUrl).toBeNull();
  });

  it('opens a Figma file at its canonical design link', () => {
    expect(unfurlOpenUrl('https://figma.com/file/AbCdEfGhIj12/x?node-id=1-2', 'figma')).toBe(
      'https://www.figma.com/design/AbCdEfGhIj12?node-id=1-2',
    );
  });
});
