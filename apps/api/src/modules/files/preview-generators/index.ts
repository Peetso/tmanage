import { heicGenerator } from './heic.js';
import { imageGenerator } from './image.js';
import { mediaMetaGenerator } from './media-meta.js';
import { svgGenerator } from './svg.js';
import { tiffGenerator } from './tiff.js';
import type { PendingPreviewSpec } from '../file-previews.repository.js';
import type { PreviewGenerator } from './types.js';

/**
 * R4 slice 3 — the kind map: which generator reads a detected type, and which derivative rows a
 * newly ready version of that type starts with. Slices 9 and 10 add media, PSD, ZIP, EPS and
 * Office generators here; a type with no generator gets no rows and the viewer shows the
 * original (or "download to view"). Video and audio (slice 9) get one facts-only `media_meta` row.
 */

export const PREVIEW_GENERATORS: readonly PreviewGenerator[] = [
  imageGenerator,
  svgGenerator,
  heicGenerator,
  tiffGenerator,
  mediaMetaGenerator,
];

export function generatorFor(
  mimeType: string | null,
  generators: readonly PreviewGenerator[] = PREVIEW_GENERATORS,
): PreviewGenerator | null {
  if (!mimeType) return null;
  return generators.find((generator) => generator.mimeTypes.includes(mimeType)) ?? null;
}

/** The detected types any generator reads — the preview job's discovery filter. */
export function previewMimeTypes(
  generators: readonly PreviewGenerator[] = PREVIEW_GENERATORS,
): readonly string[] {
  return generators.flatMap((generator) => generator.mimeTypes);
}

/** The rows a ready version of `mimeType` starts with (none for a type nothing reads). */
export function previewPlanFor(
  mimeType: string | null,
  generators: readonly PreviewGenerator[] = PREVIEW_GENERATORS,
): readonly PendingPreviewSpec[] {
  const generator = generatorFor(mimeType, generators);
  return generator && mimeType ? generator.plan(mimeType) : [];
}

export type { PreviewGenerator, PreviewLimits, PreviewOutcome, PreviewRequest } from './types.js';
export { DEFAULT_PREVIEW_LIMITS } from './types.js';
