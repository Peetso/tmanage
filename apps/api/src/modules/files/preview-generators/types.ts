import type { PendingPreviewSpec, PreviewKind } from '../file-previews.repository.js';

/**
 * R4 slice 3 — what a preview generator is given and what it answers.
 *
 * A generator is a pure function of bytes: no database, no store, no clock. The preview job reads
 * the private object once, hands every derivative the version still needs to the one generator
 * for its type, and records each answer. One call per version, so a 60-megapixel photo is decoded
 * once for its preview and its thumbnail, not once per row.
 */

export interface PreviewSource {
  readonly bytes: Uint8Array;
  /** The verifier's detected type (`file_versions.detected_mime_type`), never the declaration. */
  readonly mimeType: string;
}

export interface PreviewRequest {
  readonly kind: PreviewKind;
  /** 0 for a whole-file derivative; 1, 2 … for a page of a multi-page file. */
  readonly pageNo: number;
}

export interface PreviewLimits {
  /** Above this many pixels in one page or frame, nothing is decoded (`unsupported_too_large`). */
  readonly maxPixels: number;
  /** Pages of a multi-page file that get their own derivatives. */
  readonly maxPages: number;
}

export const DEFAULT_PREVIEW_LIMITS: PreviewLimits = {
  maxPixels: 80_000_000,
  maxPages: 20,
};

/** The long side of each raster kind, in pixels (SPEC R4 §2: preview ≤ 2048, thumb 320). */
export const PREVIEW_LONG_SIDE = 2048;
export const THUMB_LONG_SIDE = 320;

export type PreviewOutcome =
  | {
      readonly status: 'ready';
      readonly body: Uint8Array;
      readonly mimeType: string;
      readonly width: number | null;
      readonly height: number | null;
      readonly meta: Readonly<Record<string, unknown>> | null;
      /** More rows this answer showed the version needs (the other pages of a TIFF). */
      readonly followUps?: readonly PendingPreviewSpec[];
    }
  /** This derivative cannot be made here, and trying again will not change that. */
  | { readonly status: 'unsupported'; readonly code: string }
  /** The bytes would not decode. Deterministic, so the row fails at once (the viewer can retry). */
  | { readonly status: 'failed'; readonly code: string };

export interface PreviewGenerator {
  readonly name: string;
  /** The detected types this generator reads. */
  readonly mimeTypes: readonly string[];
  /** The rows a newly ready version of one of those types starts with. */
  plan(mimeType: string): readonly PendingPreviewSpec[];
  /** One answer per request, in the same order. Throws only for a fault that is not the file's. */
  generate(
    source: PreviewSource,
    requests: readonly PreviewRequest[],
    limits: PreviewLimits,
  ): Promise<readonly PreviewOutcome[]>;
}

export type PreviewRefusal = Extract<PreviewOutcome, { status: 'unsupported' | 'failed' }>;

export function unsupported(code: string): PreviewRefusal {
  return { status: 'unsupported', code };
}

export function failed(code: string): PreviewRefusal {
  return { status: 'failed', code };
}
