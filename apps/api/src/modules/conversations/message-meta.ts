import { z } from 'zod';
import { ApiError } from '../../common/http/errors.js';
import type { MessageKind } from '../../common/database/schema.js';

/**
 * R7 (0275): the facts a message of each kind carries in `messages.meta_json`. The service is the
 * write boundary, so the shape is checked here for every caller, not only the HTTP one.
 *
 * - text: optional reply `{replyToMessageId, authorUserId, excerpt}` or forward
 *   `{forwardedFromMessageId}`; no meta at all is the ordinary case.
 * - voice: `{durationMs, peaks[]}` (required).
 * - location: `{lat, lng, label}` (required).
 * - system: written by the service itself (joins, renames), never posted by a person.
 */
const uuid = z.string().uuid();

const reply = z
  .object({
    replyToMessageId: uuid,
    authorUserId: uuid,
    excerpt: z.string().max(280),
  })
  .strict();

const forward = z.object({ forwardedFromMessageId: uuid }).strict();

const voice = z
  .object({
    durationMs: z
      .number()
      .int()
      .min(1)
      .max(15 * 60 * 1000),
    peaks: z.array(z.number().min(0).max(1)).max(256),
  })
  .strict();

const location = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    label: z.string().max(200),
  })
  .strict();

const SCHEMAS: Record<Exclude<MessageKind, 'system'>, z.ZodType> = {
  text: z.union([reply, forward]).nullable(),
  voice,
  location,
};

/** The validated meta for `kind`, or a 422. `system` is refused: only the service writes it. */
export function parseMessageMeta(kind: MessageKind, raw: unknown): Record<string, unknown> | null {
  if (kind === 'system') {
    throw new ApiError(422, 'validation_failed', 'System messages cannot be posted', [
      { field: 'kind', message: 'must be text, voice or location' },
    ]);
  }
  const parsed = SCHEMAS[kind].safeParse(raw ?? null);
  if (!parsed.success) {
    throw new ApiError(422, 'validation_failed', 'The message details are not valid', [
      { field: 'meta', message: `does not match the ${kind} shape` },
    ]);
  }
  return (parsed.data as Record<string, unknown> | null) ?? null;
}
