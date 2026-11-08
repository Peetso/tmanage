'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@tmanage/ui';
import { encodeQr, qrSvgPath } from '../../lib/qr/qr-code';
import { useTOr } from '../../lib/i18n/use-t-or';

/** The sandbox an embedded form runs in: it can render and send its answers, nothing more. */
export const EMBED_SANDBOX = 'allow-forms allow-scripts allow-same-origin';

function attribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/** 52-20. The `<iframe>` an owner pastes on their own site to show the public form. */
export function embedSnippet(url: string, title: string): string {
  return (
    `<iframe src="${attribute(url)}" title="${attribute(title)}" width="100%" height="720" ` +
    `style="border:0" loading="lazy" sandbox="${EMBED_SANDBOX}" ` +
    `referrerpolicy="strict-origin-when-cross-origin"></iframe>`
  );
}

/** 52-20. A standalone SVG document of the QR code, for download and print. */
export function qrSvgDocument(url: string): {
  readonly path: string;
  readonly side: number;
  readonly svg: string;
} {
  const matrix = encodeQr(url);
  const side = matrix.size + 8;
  const path = qrSvgPath(matrix);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return { path, side, svg };
}

export interface WorkFormShareExtrasProps {
  /** The public address, `https://…/f/<slug>`. */
  readonly url: string;
  readonly formName: string;
}

/**
 * 52-20 — the two other ways to share a published form, under the link on the publish panel:
 * a QR code drawn in code (no external service) with an SVG download, and an embed snippet whose
 * `<iframe>` carries a sandbox. Figma: Product page section 581:32859 (frames 581:32891 EN, 581:32933 AR).
 */
export function WorkFormShareExtras({ url, formName }: WorkFormShareExtrasProps) {
  const tOr = useTOr();
  const [copied, setCopied] = useState(false);
  const qr = useMemo(() => qrSvgDocument(url), [url]);
  const snippet = useMemo(() => embedSnippet(url, formName), [url, formName]);
  const origin = useMemo(() => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }, [url]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const download = () => {
    const href = URL.createObjectURL(new Blob([qr.svg], { type: 'image/svg+xml' }));
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'form-qr.svg';
    anchor.click();
    URL.revokeObjectURL(href);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      // No clipboard permission: the snippet text is selectable (user-select: all).
      setCopied(false);
    }
  };

  return (
    <div className="wf-share">
      <div className="wf-share__qr-row">
        <svg
          className="wf-share__qr"
          viewBox={`0 0 ${qr.side} ${qr.side}`}
          shapeRendering="crispEdges"
          role="img"
          aria-label={tOr('WorkFormsPublic.qrLabel', 'QR code of the form link')}
        >
          <rect width={qr.side} height={qr.side} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
        <div className="wf-share__qr-text">
          <h4 className="wf-share__title">{tOr('WorkFormsPublic.qrTitle', 'QR code')}</h4>
          <p className="wf-link__body">
            {tOr(
              'WorkFormsPublic.qrBody',
              'Print it or show it on a screen. Scanning it opens this form.',
            )}
          </p>
          <Button tone="outline" onClick={download}>
            {tOr('WorkFormsPublic.qrDownload', 'Download SVG')}
          </Button>
        </div>
      </div>

      <div className="wf-share__embed">
        <h4 className="wf-share__title">
          {tOr('WorkFormsPublic.embedTitle', 'Embed on your website')}
        </h4>
        <pre
          className="wf-share__code"
          dir="ltr"
          aria-label={tOr('WorkFormsPublic.embedLabel', 'Embed code')}
        >
          {snippet}
        </pre>
        <p className="wf-share__note">
          {tOr(
            'WorkFormsPublic.embedNote',
            'The form runs in a sandbox: it can show itself and send answers, nothing else. If your site sets a Content-Security-Policy, add this address to its frame-src allow-list:',
          )}{' '}
          <span className="wf-share__origin" dir="ltr">
            {origin}
          </span>
        </p>
        <div className="wf-link__actions">
          <Button tone="ink" size="compact" onClick={() => void copy()}>
            {copied
              ? tOr('WorkFormsPublic.embedCopied', 'Code copied')
              : tOr('WorkFormsPublic.embedCopy', 'Copy code')}
          </Button>
        </div>
      </div>
    </div>
  );
}
