'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import { useTOr } from '../../lib/i18n/use-t-or';
import { highlightLines, type HighlightedLine } from './code-highlight';
import { parseCsv } from './csv-parse';
import { aciColor, parseDxf, type DxfDrawing } from './dxf-parse';
import { fetchHead, findEmbeddedPng, THUMBNAIL_SCAN_BYTES } from './embedded-thumbnail';
import {
  desktopFormatFor,
  mayCarryThumbnail,
  type CodeLanguage,
  type DesktopFormat,
  type TextView,
} from './file-formats';
import { FormatIcon } from './format-icons';
import { useParsedOriginal, type OriginalFetcher } from './format-stage-helpers';
import { UnsupportedStage, unsupportedReasonFor } from './UnsupportedStage';
import './format-stages.css';
import './file-text-stages.css';

/**
 * Peter, 2026-11-09 (viewer item 8) — the viewers for what an agency's developers, content
 * writers, accountants and architects upload, beside the R4 image / PDF / Office / media stages:
 *
 * - **code** (`.ts`, `.py`, `.sql`, `.json`, `.md`, `.yaml` …): line numbers and colours from the
 *   built-in highlighter, drawn as React spans (no HTML string reaches the DOM);
 * - **CSV**: a table;
 * - **HTML**: a preview in `<iframe sandbox="">` — no scripts, forms, popups or navigation, an
 *   opaque origin — whose `src` is a blob made here from the file's text, and the source view;
 * - **DXF**: the drawing, read by `dxf-parse.ts` and drawn as SVG elements;
 * - **DWG, SketchUp, Revit, IFC**: the info card with the apps that open them, and the preview
 *   picture the file saves inside itself when there is one.
 *
 * Each reads at most the first {@link TEXT_READ_BYTES} (or {@link THUMBNAIL_SCAN_BYTES}) of the
 * original over the session cookie and says when it shows only part of a file.
 */

/** The most of a text original the viewer reads. */
export const TEXT_READ_BYTES = 2 * 1024 * 1024;
/** The most lines the code view colours and shows. */
export const MAX_CODE_LINES = 5_000;

interface TextOriginal {
  readonly text: string;
  /** The read stopped at {@link TEXT_READ_BYTES}. */
  readonly cut: boolean;
}

const fetchTextHead: OriginalFetcher = async (src) => {
  const bytes = await fetchHead(src, TEXT_READ_BYTES + 1);
  return bytes.slice().buffer;
};

async function decodeText(buffer: ArrayBuffer): Promise<TextOriginal> {
  const cut = buffer.byteLength > TEXT_READ_BYTES;
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, TEXT_READ_BYTES));
  return { text: new TextDecoder('utf-8').decode(bytes), cut };
}

export interface TextFileStageProps {
  readonly src: string | null;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly view: TextView;
  readonly onDownload?: (() => void) | undefined;
  /** Test seam: how the original's bytes are read. */
  readonly fetcher?: OriginalFetcher;
}

/** The stage for a text original: picks the code, table, web page or drawing view. */
export function TextFileStage({
  src,
  fileName,
  view,
  onDownload,
  fetcher = fetchTextHead,
}: TextFileStageProps) {
  const tOr = useTOr();
  const loaded = useParsedOriginal(src, decodeText, fetcher);
  if (loaded.state === 'loading') {
    return (
      <div className="tm-format-loading" role="status">
        {tOr('ViewerFiles.loading', 'Opening the file…')}
      </div>
    );
  }
  if (loaded.state === 'failed') return <TextFailed onDownload={onDownload} />;
  const { text, cut } = loaded.value;
  const cutNotice = cut ? (
    <InlineAlert className="tm-format-notice">
      {tOr(
        'ViewerFiles.cut',
        'This file is large: only its beginning is shown. Download it to see all of it.',
      )}
    </InlineAlert>
  ) : null;
  return (
    <div className="tm-filetext">
      {cutNotice}
      {view.view === 'html' ? (
        <HtmlView text={text} fileName={fileName} />
      ) : view.view === 'csv' ? (
        <CsvView text={text} fileName={fileName} delimiter={view.delimiter} />
      ) : view.view === 'dxf' ? (
        <DxfView text={text} fileName={fileName} onDownload={onDownload} />
      ) : (
        <CodeView text={text} fileName={fileName} language={view.language} />
      )}
    </div>
  );
}

function TextFailed({ onDownload }: { readonly onDownload?: (() => void) | undefined }) {
  const tOr = useTOr();
  return (
    <div className="tm-format-empty" role="group">
      <h2 className="tm-format-empty__title">
        {tOr('ViewerFiles.failedTitle', 'This file could not be opened here')}
      </h2>
      <p className="tm-format-empty__body">
        {tOr('ViewerFiles.failedBody', 'Download the original to open it on your computer.')}
      </p>
      {onDownload ? (
        <Button tone="ink" onClick={onDownload}>
          <FormatIcon name="download" />
          <span>{tOr('ViewerFormats.unsupported.download', 'Download to view')}</span>
        </Button>
      ) : null}
    </div>
  );
}

// ── Code ────────────────────────────────────────────────────────────────────

export function CodeView({
  text,
  fileName,
  language,
}: {
  readonly text: string;
  readonly fileName: string;
  readonly language: CodeLanguage;
}) {
  const tOr = useTOr();
  // A file that ends with a newline has no empty last line to number.
  const body = useMemo(() => text.replace(/\r?\n$/u, ''), [text]);
  const lines = useMemo<HighlightedLine[]>(() => {
    const all = highlightLines(body, language);
    return all.length > MAX_CODE_LINES ? all.slice(0, MAX_CODE_LINES) : all;
  }, [body, language]);
  const totalLines = useMemo(() => body.split(/\r\n?|\n/u).length, [body]);
  return (
    <div className="tm-code" dir="ltr">
      {totalLines > MAX_CODE_LINES ? (
        <InlineAlert className="tm-format-notice">
          {tOr(
            'ViewerFiles.codeCut',
            'Showing the first {count} lines. Download the file to see all of it.',
          ).replace('{count}', String(MAX_CODE_LINES))}
        </InlineAlert>
      ) : null}
      <pre
        className="tm-code__pre"
        data-language={language}
        role="region"
        aria-label={tOr('ViewerFiles.codeLabel', '{name}, {count} lines')
          .replace('{name}', fileName)
          .replace('{count}', String(totalLines))}
      >
        <code>
          {lines.map((line, index) => (
            <span className="tm-code__line" key={index}>
              <span className="tm-code__no" aria-hidden="true">
                {index + 1}
              </span>
              <span className="tm-code__text">
                {line.map((token, at) =>
                  token.kind === 'plain' ? (
                    token.text
                  ) : (
                    <span key={at} className="tm-code__tok" data-token={token.kind}>
                      {token.text}
                    </span>
                  ),
                )}
                {'\n'}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export function CsvView({
  text,
  fileName,
  delimiter,
}: {
  readonly text: string;
  readonly fileName: string;
  readonly delimiter: ',' | ';' | '\t' | null;
}) {
  const tOr = useTOr();
  const table = useMemo(() => parseCsv(text, delimiter), [text, delimiter]);
  const [head, ...body] = table.rows;
  return (
    <div className="tm-xlsx tm-csv">
      {table.truncated ? (
        <InlineAlert className="tm-format-notice">
          {tOr(
            'ViewerFiles.csvCut',
            'Showing the first {count} rows. Download the file to see all of it.',
          ).replace('{count}', String(table.rows.length))}
        </InlineAlert>
      ) : null}
      <div className="tm-xlsx__scroll">
        <table
          className="tm-xlsx__grid"
          aria-label={tOr('ViewerFiles.csvLabel', 'Table of {name}').replace('{name}', fileName)}
        >
          {head ? (
            <thead>
              <tr>
                <th className="tm-xlsx__corner" scope="col" aria-hidden="true" />
                {Array.from({ length: table.columns }, (_, column) => (
                  <th key={column} className="tm-xlsx__col" scope="col">
                    {head[column] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, index) => (
              <tr key={index}>
                <th className="tm-xlsx__row" scope="row">
                  {index + 2}
                </th>
                {Array.from({ length: table.columns }, (_, column) => {
                  const value = row[column] ?? '';
                  return (
                    <td
                      key={column}
                      className="tm-xlsx__cell tm-csv__cell"
                      data-numeric={/^-?[\d.,\s]+%?$/u.test(value.trim()) && value.trim() !== ''}
                    >
                      <span className="tm-xlsx__text">{value}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── HTML ────────────────────────────────────────────────────────────────────

/**
 * The page in a frame with an empty `sandbox` (no `allow-*` token at all): no script runs, no
 * form posts, no popup opens, nothing navigates the viewer, and the frame's origin is opaque, so
 * it can read nothing of TManage's. Its `src` is a blob URL of the file's own text; the page's
 * policy (`frame-src blob:`) admits such a frame, and the blob document inherits that policy too.
 */
export function HtmlView({ text, fileName }: { readonly text: string; readonly fileName: string }) {
  const tOr = useTOr();
  const tabsId = useId();
  const [tab, setTab] = useState<'preview' | 'source'>('preview');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'preview' || typeof URL.createObjectURL !== 'function') return undefined;
    const made = URL.createObjectURL(new Blob([text], { type: 'text/html' }));
    setUrl(made);
    return () => {
      URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [text, tab]);
  return (
    <div className="tm-htmlview">
      <div
        className="tm-htmlview__tabs"
        role="tablist"
        aria-label={tOr('ViewerFiles.htmlTabs', 'How to show this page')}
      >
        {(['preview', 'source'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${tabsId}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${tabsId}-panel`}
            className="tm-htmlview__tab"
            onClick={() => setTab(name)}
          >
            {name === 'preview'
              ? tOr('ViewerFiles.htmlPreview', 'Preview')
              : tOr('ViewerFiles.htmlSource', 'Source')}
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
        {tab === 'preview' ? (
          <>
            <p className="tm-htmlview__note">
              {tOr(
                'ViewerFiles.htmlNote',
                'Scripts, forms and links are switched off in this preview, so the page can look simpler than in a browser.',
              )}
            </p>
            {url ? (
              <iframe
                className="tm-htmlview__frame"
                sandbox=""
                src={url}
                referrerPolicy="no-referrer"
                title={tOr('ViewerFiles.htmlFrameTitle', 'Preview of {name}').replace(
                  '{name}',
                  fileName,
                )}
              />
            ) : null}
          </>
        ) : (
          <CodeView text={text} fileName={fileName} language="markup" />
        )}
      </div>
    </div>
  );
}

// ── DXF ─────────────────────────────────────────────────────────────────────

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;

export function DxfView({
  text,
  fileName,
  onDownload,
}: {
  readonly text: string;
  readonly fileName: string;
  readonly onDownload?: (() => void) | undefined;
}) {
  const tOr = useTOr();
  const drawing = useMemo<DxfDrawing>(() => parseDxf(text), [text]);
  const [step, setStep] = useState(2);
  const zoom = ZOOM_STEPS[step] ?? 1;
  const bounds = drawing.bounds;
  if (!bounds || drawing.shapes.length === 0) {
    return (
      <div className="tm-format-empty" role="group">
        <h2 className="tm-format-empty__title">
          {tOr('ViewerFiles.dxfEmptyTitle', 'Nothing to draw here')}
        </h2>
        <p className="tm-format-empty__body">
          {tOr(
            'ViewerFiles.dxfEmpty',
            'This drawing has nothing we can draw in the browser. Download it to open in a CAD app.',
          )}
        </p>
        {onDownload ? (
          <Button tone="ink" onClick={onDownload}>
            <FormatIcon name="download" />
            <span>{tOr('ViewerFormats.unsupported.download', 'Download to view')}</span>
          </Button>
        ) : null}
      </div>
    );
  }
  const width = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const height = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const pad = Math.max(width, height) * 0.03;
  // The drawing's y grows upwards; SVG's grows downwards, so every y is negated.
  const viewBox = `${bounds.minX - pad} ${-bounds.maxY - pad} ${width + pad * 2} ${height + pad * 2}`;
  const dot = Math.max(width, height) / 400;
  return (
    <div className="tm-dxf" dir="ltr">
      <div className="tm-dxf__bar">
        <span className="tm-dxf__count">
          {tOr('ViewerFiles.dxfCount', '{count} shapes').replace(
            '{count}',
            String(drawing.shapes.length),
          )}
        </span>
        <span className="tm-dxf__zoom">
          <button
            type="button"
            className="tm-format-stepper__button"
            aria-label={tOr('ViewerFiles.zoomOut', 'Zoom out')}
            disabled={step === 0}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
          >
            −
          </button>
          <button
            type="button"
            className="tm-dxf__fit"
            onClick={() => setStep(2)}
            aria-label={tOr('ViewerFiles.zoomFit', 'Fit to screen')}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="tm-format-stepper__button"
            aria-label={tOr('ViewerFiles.zoomIn', 'Zoom in')}
            disabled={step === ZOOM_STEPS.length - 1}
            onClick={() => setStep((current) => Math.min(ZOOM_STEPS.length - 1, current + 1))}
          >
            +
          </button>
        </span>
      </div>
      {drawing.skipped > 0 || drawing.truncated ? (
        <p className="tm-dxf__skipped">
          {tOr(
            'ViewerFiles.dxfSkipped',
            '{count} items (hatches, dimensions or 3D parts) are not drawn here.',
          ).replace('{count}', String(drawing.skipped))}
        </p>
      ) : null}
      <div className="tm-dxf__scroll">
        <svg
          className="tm-dxf__svg"
          role="img"
          aria-label={tOr('ViewerFiles.dxfLabel', 'Drawing of {name}').replace('{name}', fileName)}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          style={{ inlineSize: `${zoom * 100}%`, blockSize: `${zoom * 100}%` }}
        >
          {drawing.shapes.map((shape, index) => {
            const stroke = aciColor(shape.color) ?? 'currentColor';
            if (shape.type === 'path') {
              const points = shape.points.map((p) => `${p.x},${-p.y}`).join(' ');
              return shape.closed ? (
                <polygon
                  key={index}
                  points={points}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <polyline
                  key={index}
                  points={points}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            }
            if (shape.type === 'circle') {
              return (
                <circle
                  key={index}
                  cx={shape.cx}
                  cy={-shape.cy}
                  r={shape.r > 0 ? shape.r : dot}
                  fill={shape.r > 0 ? 'none' : stroke}
                  stroke={stroke}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              );
            }
            return (
              <text
                key={index}
                x={shape.x}
                y={-shape.y}
                fontSize={shape.height}
                fill={stroke}
                transform={
                  shape.rotation ? `rotate(${-shape.rotation} ${shape.x} ${-shape.y})` : undefined
                }
              >
                {shape.text}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ── Desktop formats (DWG, SketchUp, Revit, IFC) ────────────────────────────

type Thumb = { readonly state: 'none' } | { readonly state: 'ready'; readonly url: string };

/** Reads the head of the original and makes a blob URL of the PNG saved inside it, if any. */
export function useEmbeddedThumbnail(
  src: string | null,
  enabled: boolean,
  read: (src: string, limit: number) => Promise<Uint8Array> = fetchHead,
): Thumb {
  const [thumb, setThumb] = useState<Thumb>({ state: 'none' });
  useEffect(() => {
    if (!src || !enabled || typeof URL.createObjectURL !== 'function') return undefined;
    let live = true;
    let made: string | null = null;
    read(src, THUMBNAIL_SCAN_BYTES)
      .then((bytes) => {
        const png = findEmbeddedPng(bytes);
        if (!png || !live) return;
        made = URL.createObjectURL(new Blob([png.slice()], { type: 'image/png' }));
        setThumb({ state: 'ready', url: made });
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setThumb({ state: 'none' });
    };
    // `read` is a module-level function in every caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, enabled]);
  return thumb;
}

const DESKTOP_TEXT: Readonly<
  Record<
    Exclude<DesktopFormat, 'eps' | 'other'>,
    { readonly type: [string, string]; readonly apps: [string, string] }
  >
> = {
  dwg: {
    type: ['ViewerFiles.type.dwg', 'AutoCAD drawing'],
    apps: ['ViewerFiles.apps.dwg', 'Opens in AutoCAD, or in the free Autodesk DWG TrueView.'],
  },
  skp: {
    type: ['ViewerFiles.type.skp', 'SketchUp model'],
    apps: ['ViewerFiles.apps.skp', 'Opens in SketchUp, or free in SketchUp for Web.'],
  },
  rvt: {
    type: ['ViewerFiles.type.rvt', 'Revit model'],
    apps: ['ViewerFiles.apps.rvt', 'Opens in Autodesk Revit, or in the free Autodesk Viewer.'],
  },
  ifc: {
    type: ['ViewerFiles.type.ifc', 'IFC building model'],
    apps: [
      'ViewerFiles.apps.ifc',
      'Opens in any BIM app, or in a free IFC viewer such as BIMcollab Zoom.',
    ],
  },
  legacy_office: {
    type: ['ViewerFiles.type.legacyOffice', 'Older Office file'],
    apps: [
      'ViewerFiles.apps.legacyOffice',
      'Opens in Microsoft Office, LibreOffice or Google Docs. Saving it as .docx, .xlsx or .pptx lets TManage show it here.',
    ],
  },
};

export interface DesktopFileStageProps {
  readonly src: string | null;
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly onDownload?: (() => void) | undefined;
  /** Test seam: how the head of the original is read. */
  readonly read?: (src: string, limit: number) => Promise<Uint8Array>;
}

/** The info card for a file only a desktop app opens, with its saved preview when one exists. */
export function DesktopFileStage({
  src,
  fileName,
  mimeType,
  sizeBytes,
  onDownload,
  read,
}: DesktopFileStageProps) {
  const tOr = useTOr();
  const format = desktopFormatFor(fileName, mimeType);
  const thumb = useEmbeddedThumbnail(src, mayCarryThumbnail(format), read);
  const words = format === 'eps' || format === 'other' ? null : DESKTOP_TEXT[format];
  return (
    <UnsupportedStage
      fileName={fileName}
      mimeType={mimeType}
      sizeBytes={sizeBytes}
      reason={unsupportedReasonFor(mimeType)}
      showName
      {...(onDownload ? { onDownload } : {})}
      {...(words
        ? {
            bodyText: tOr(
              'ViewerFiles.desktopBody',
              'This type of file can’t be drawn in the browser. Download it to open in the app it was made with.',
            ),
            typeName: tOr(words.type[0], words.type[1]),
            opensWith: tOr(words.apps[0], words.apps[1]),
          }
        : {})}
      thumbnail={
        thumb.state === 'ready'
          ? {
              src: thumb.url,
              alt: tOr('ViewerFiles.thumbAlt', 'Preview picture saved inside {name}').replace(
                '{name}',
                fileName,
              ),
              chip: tOr('ViewerFiles.thumbChip', 'Preview saved inside the file'),
            }
          : null
      }
    />
  );
}
