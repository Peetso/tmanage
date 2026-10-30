import { randomBytes } from 'node:crypto';
import { ApiError } from '../../common/http/errors.js';
import type { WorkFormFieldDef, WorkFormFieldType } from '../../common/database/schema.js';

/**
 * 52-20 — the pure half of the public intake door: slugs, references, the opaque public
 * definition and the per-field value check. No I/O, so every rule here is a unit test.
 *
 * ## Opaque keys
 *
 * A visitor never sees a form's internal identity: the public definition names each field by its
 * position (`f1`, `f2`, …) and the submission is keyed the same way. The door maps a key back to
 * the field label server-side, so a request cannot name a label, an id, a project or an
 * organization — any key outside the list is a 400.
 */

/** 32 symbols (no `l`, `o`, `0`, `1`): a byte's low five bits pick one uniformly. */
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PUBLIC_SLUG_LENGTH = 10;
const SLUG_SHAPE = /^[a-km-np-z2-9]{10}$/;

/** Text values are short answers (spec 52 §52-20: text 200). */
export const MAX_TEXT_VALUE = 200;
/** A date-time string longer than this is not an ISO-8601 instant. */
const MAX_DATE_VALUE = 40;
/** Beyond this a "number" is noise, not an answer. */
const MAX_ABS_NUMBER = 1e12;

function randomOf(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += alphabet[byte & 31];
  return out;
}

/** A fresh public slug: 10 symbols of 32, 50 bits — not guessable, not enumerable. */
export function newPublicSlug(): string {
  return randomOf(SLUG_ALPHABET, PUBLIC_SLUG_LENGTH);
}

/** Checked before any lookup, so a malformed slug costs nothing and answers the same 404. */
export function isPublicSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_SHAPE.test(value);
}

/** The reference a visitor can quote: `REQ-` plus 6 symbols, unique per organization. */
export function newSubmissionReference(): string {
  return `REQ-${randomOf(REFERENCE_ALPHABET, 6)}`;
}

/** One field as a visitor sees it: no label key, no id, nothing internal. */
export interface PublicFormField {
  readonly key: string;
  readonly label: string;
  readonly type: WorkFormFieldType;
  readonly required: boolean;
  readonly maxLength?: number;
}

export interface PublicFormDefinition {
  readonly title: string;
  readonly fields: readonly PublicFormField[];
}

const keyAt = (index: number): string => `f${index + 1}`;

/**
 * The definition `GET /v1/public/forms/:slug` returns: the title and the fields under opaque
 * keys. An explicit projection — the form's id, organization, author, slug and dates never leave.
 */
export function toPublicDefinition(
  name: string,
  fields: readonly WorkFormFieldDef[],
): PublicFormDefinition {
  return {
    title: name,
    fields: fields.map((field, index) => ({
      key: keyAt(index),
      label: field.label,
      type: field.type,
      required: field.required,
      ...(field.type === 'text' ? { maxLength: MAX_TEXT_VALUE } : {}),
    })),
  };
}

export type SubmittedValue = string | number | boolean;

/**
 * Check a public submission's `values` (keyed `f1…fn`) against the form's fields, and return
 * them keyed by field label — the shape `form_submissions.values_json` stores. Every value is
 * typed per its field and length-capped; unknown keys, missing required answers and wrong types
 * are collected and thrown together as one 400 whose details name only the opaque keys.
 */
export function checkPublicValues(
  fields: readonly WorkFormFieldDef[],
  rawValues: unknown,
): Readonly<Record<string, SubmittedValue>> {
  if (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues)) {
    throw new ApiError(400, 'validation_failed', 'The form is not filled in correctly', [
      { field: 'values', message: 'must be an object' },
    ]);
  }
  const values = rawValues as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const keys = new Set(fields.map((_, index) => keyAt(index)));
  for (const key of Object.keys(values)) {
    if (!keys.has(key)) details.push({ field: `values.${key}`, message: 'is not on this form' });
  }

  const out: Record<string, SubmittedValue> = {};
  fields.forEach((field, index) => {
    const key = keyAt(index);
    const at = `values.${key}`;
    const raw = Object.hasOwn(values, key) ? values[key] : undefined;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === null || value === '') {
      if (field.required) details.push({ field: at, message: 'is required' });
      return;
    }
    const problem = typeProblem(field.type, value);
    if (problem !== null) details.push({ field: at, message: problem });
    else out[field.label] = value as SubmittedValue;
  });

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The form is not filled in correctly', details);
  }
  return out;
}

function typeProblem(type: WorkFormFieldType, value: unknown): string | null {
  switch (type) {
    case 'text':
      if (typeof value !== 'string') return 'must be text';
      return value.length > MAX_TEXT_VALUE ? `must be ${MAX_TEXT_VALUE} characters or fewer` : null;
    case 'number':
      return typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= MAX_ABS_NUMBER
        ? null
        : 'must be a number';
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'must be yes or no';
    case 'date':
      return typeof value === 'string' &&
        value.length <= MAX_DATE_VALUE &&
        !Number.isNaN(new Date(value).getTime())
        ? null
        : 'must be a date';
  }
}

/** The work item a conversion files: the values as plain `label: value` lines, bounded. */
export function submissionDescription(
  reference: string,
  values: Readonly<Record<string, SubmittedValue>>,
): string {
  const lines = [
    `Public form submission ${reference}`,
    ...Object.entries(values).map(([label, value]) => `${label}: ${String(value)}`),
  ];
  return lines.join('\n').slice(0, 5000);
}
