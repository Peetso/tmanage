import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Loads a PDF with pdf.js in the browser (R4 slice 6).
 *
 * - pdf.js is imported on demand, so no other screen pays for it and server rendering never
 *   touches it.
 * - The worker is our own copy at `/pdf.worker.min.mjs` (same origin), which the CSP's
 *   `worker-src 'self'` admits; `tests/pdf-worker-version.test.ts` keeps the copy in step with the
 *   installed `pdfjs-dist`.
 * - The bytes come from the API origin with the session cookie (`withCredentials`), in ranges when
 *   the API answers `Accept-Ranges` (slice 4), so a 200-page file opens without downloading it all.
 * - `isEvalSupported: false`: pdf.js never compiles code from a file.
 */
export const PDF_WORKER_PATH = '/pdf.worker.min.mjs';

/** pdf.js measures in points (1/72 in); the screen in CSS pixels (1/96 in). */
export const PDF_POINTS_TO_CSS = 96 / 72;

export type PdfDocument = PDFDocumentProxy;

export interface PdfLoad {
  readonly promise: Promise<PdfDocument>;
  readonly cancel: () => void;
}

export function loadPdfDocument(url: string): PdfLoad {
  let destroy: (() => void) | null = null;
  let cancelled = false;
  const promise = import('pdfjs-dist').then(async (pdfjs) => {
    if (pdfjs.GlobalWorkerOptions.workerSrc !== PDF_WORKER_PATH) {
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_PATH;
    }
    const task = pdfjs.getDocument({
      url,
      withCredentials: true,
      isEvalSupported: false,
      disableAutoFetch: true,
    });
    destroy = () => {
      void task.destroy();
    };
    if (cancelled) destroy();
    return task.promise;
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      destroy?.();
    },
  };
}
