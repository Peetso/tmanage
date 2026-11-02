import { describe, expect, it } from 'vitest';
import { basecampHtmlToMarkdown, basecampMessageToDocument } from './basecamp-html.js';

const HOSTILE = [
  '<p>Hello <strong>team</strong> &amp; friends</p>',
  '<script>alert(1)</script>',
  '<iframe src="https://evil.example"></iframe>',
  '<p onclick="steal()">Click <a href="javascript:alert(1)">here</a></p>',
  '<p><img src="https://cdn.example/x.png"><img src="files/plan.png" alt="Plan"></p>',
  '<p>مرحبا بالفريق</p>',
].join('');

describe('basecampHtmlToMarkdown', () => {
  it('strips script, iframe, event handlers and external images (SEC) and marks RTL', () => {
    const { markdown, stripped } = basecampHtmlToMarkdown(HOSTILE);
    expect(stripped).toEqual(['script', 'iframe', 'onclick', 'img']);
    expect(markdown).not.toMatch(/<(script|iframe)/i);
    expect(markdown).not.toContain('javascript:');
    expect(markdown).toContain('Hello **team** & friends');
    expect(markdown).toContain('Click here');
    expect(markdown).toContain('[image: Plan](files/plan.png)');
    expect(markdown.match(/dir="rtl"/g)).toHaveLength(1);
    expect(markdown).toContain('<p dir="rtl">\n\nمرحبا بالفريق\n\n</p>');
  });
});

describe('basecampMessageToDocument', () => {
  it('builds one document with the archive header and both comment authors', () => {
    const doc = basecampMessageToDocument({
      path: 'projects/site/messages/1.html',
      title: 'Kickoff',
      author: 'Sam',
      postedAt: '2026-03-01 10:00',
      html: '<p>Agenda</p>',
      comments: [
        { author: 'Ali', postedAt: '2026-03-01 11:00', html: '<p>Yes</p>' },
        { author: 'Mona', postedAt: '2026-03-01 12:00', html: '<p>Agreed</p>' },
      ],
    });
    expect(doc.body.startsWith('Imported from Basecamp: projects/site/messages/1.html')).toBe(true);
    expect(doc.body).toContain('## Comments');
    expect(doc.body).toContain('**Ali · 2026-03-01 11:00**');
    expect(doc.body).toContain('**Mona · 2026-03-01 12:00**');
  });
});
