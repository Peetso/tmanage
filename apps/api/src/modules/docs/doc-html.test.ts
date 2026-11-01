import { expect, it } from 'vitest';
import { sanitizeDocHtml } from './doc-html.js';

// R5 slice 2: one row per R5-SPEC §3 policy — [input, sanitised output].
const IMG = '/v1/organizations/acme/files/0190aa00-0000-7000-8000-000000000001/content';
const KEEP = `<div data-type="callout" data-kind="warn">c</div><p><span data-type="mention" data-id="u" data-label="S">@S</span><mark data-comment="c1">q</mark></p>`;
const EMBED = '<div data-type="embed"></div>';
const ALIGN = '<p style="text-align: center">a</p>';
const run = (html: string) => sanitizeDocHtml(html, { orgSlug: 'acme' });
it.each([
  ['<p>a</p><script>x</script>', '<p>a</p>'], // script dropped
  ['<p>a</p><img src="data:image/png;base64,AA">', '<p>a</p>'], // data: image
  ['<p>a</p><img src="https://evil.example/x.png">', '<p>a</p>'], // foreign image
  [`<img src="${IMG}" onerror="x">`, `<img src="${IMG}">`], // same-site image kept
  ['<a href="javascript:x">l</a>', '<a>l</a>'], // javascript: href
  [KEEP, KEEP], // callout / mention / comment attributes kept
  [EMBED.replace('>', ' data-url="https://evil.example/">'), EMBED], // embed host allowlist
  [`${ALIGN}<p style="color:red">b</p>`, `${ALIGN}<p>b</p>`], // text-align style only
])('sanitises %s', (input, output) => expect(run(input)).toBe(output));
it('refuses an oversize result with 422', () =>
  expect(() => run(`<p>${'&'.repeat(400_000)}</p>`)).toThrow(
    expect.objectContaining({ status: 422 }),
  ));
