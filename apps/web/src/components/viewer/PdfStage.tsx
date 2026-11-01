'use client';

import { useEffect, useRef, useState } from 'react';
import { loadPdfDocument, PDF_POINTS_TO_CSS, type PdfDocument } from './pdf-document';

export type PdfDocumentState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly doc: PdfDocument }
  | { readonly status: 'error' };

/** Opens the PDF at `url` (absolute, credentialed) once per URL; `null` keeps it closed. */
export function usePdfDocument(url: string | null): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ status: 'loading' });

  useEffect(() => {
    if (!url) return undefined;
    setState({ status: 'loading' });
    const load = loadPdfDocument(url);
    let live = true;
    load.promise.then(
      (doc) => {
        if (live) setState({ status: 'ready', doc });
      },
      () => {
        if (live) setState({ status: 'error' });
      },
    );
    return () => {
      live = false;
      load.cancel();
    };
  }, [url]);

  return state;
}

interface RenderTask {
  readonly promise: Promise<unknown>;
  cancel(): void;
}

/**
 * Draws one page into `canvas` at `cssScale` (CSS px per PDF point × zoom), sharp on high-density
 * screens. Returns a cancel for the render in flight.
 */
function drawPage(
  doc: PdfDocument,
  pageNo: number,
  canvas: HTMLCanvasElement,
  cssScale: number,
  onSize?: (size: { width: number; height: number }) => void,
): () => void {
  let task: RenderTask | null = null;
  let cancelled = false;
  void doc.getPage(pageNo).then((page) => {
    if (cancelled) return;
    const base = page.getViewport({ scale: PDF_POINTS_TO_CSS });
    onSize?.({ width: base.width, height: base.height });
    const ratio = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: cssScale * ratio });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) return;
    task = page.render({ canvas, canvasContext: context, viewport }) as unknown as RenderTask;
    task.promise.catch(() => undefined);
  });
  return () => {
    cancelled = true;
    task?.cancel();
  };
}

export interface PdfStageProps {
  readonly doc: PdfDocument;
  readonly pageNo: number;
  readonly zoom: number;
  readonly label: string;
  /** The page's size at 100 % in CSS pixels. */
  readonly onNaturalSize: (size: { readonly width: number; readonly height: number }) => void;
}

/**
 * V-04 — one PDF page drawn by pdf.js onto a canvas that fills the artwork box. Pins are tied to
 * their page; the stage shows one page at a time and the page strip moves between them.
 */
export function PdfStage({ doc, pageNo, zoom, label, onNaturalSize }: PdfStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef(onNaturalSize);
  sizeRef.current = onNaturalSize;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    return drawPage(doc, pageNo, canvas, PDF_POINTS_TO_CSS * zoom, (size) => sizeRef.current(size));
  }, [doc, pageNo, zoom]);

  return <canvas ref={canvasRef} className="tm-viewer-art__media" role="img" aria-label={label} />;
}

/** A small page picture for the page strip (about 96 px wide). */
export function PdfThumb({ doc, pageNo }: { readonly doc: PdfDocument; readonly pageNo: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // 96 px wide for a US-letter / A4 page.
    return drawPage(doc, pageNo, canvas, 0.16);
  }, [doc, pageNo]);

  return <canvas ref={canvasRef} className="tm-viewer-strip__canvas" aria-hidden="true" />;
}
