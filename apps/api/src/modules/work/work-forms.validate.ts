import { ApiError } from '../../common/http/errors.js';
import { WORK_FORM_FIELD_TYPES } from '../../common/database/schema.js';
import type { WorkFormFieldDef, WorkFormFieldType } from '../../common/database/schema.js';

/**
 * Validation for WORK intake forms (x146), lifted out of the controller so the two validations —
 * the field *definition* a form is created with, and a *submission's* payload against those fields —
 * are one testable unit and the controller stays about routing.
 *
 * Both raise `ApiError(400, 'validation_failed', …)` with the same `{ field, message }` detail shape
 * every other controller uses, so a bad definition and a bad submission are ordinary 400s the
 * `HttpExceptionFilter` maps, never a 500.
 */

/** `work_forms.name` is `VARCHAR(300)`. */
const MAX_NAME_LENGTH = 300;
/** A field label is a short handle, not prose. */
const MAX_LABEL_LENGTH = 200;
/** A guard on the definition size — an intake form is small, not an unbounded schema. */
const MAX_FIELDS = 50;

function isFieldType(value: unknown): value is WorkFormFieldType {
  return typeof value === 'string' && (WORK_FORM_FIELD_TYPES as readonly string[]).includes(value);
}

/**
 * Validate the `name` of a form and return it trimmed, or throw 400.
 */
export function validateFormName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` },
    ]);
  }
  return name;
}

/**
 * Validate the `fields` of a create body and return the typed definitions, or throw 400.
 *
 * Each field is `{ label, type, required }`: a non-empty label (unique within the form), a `type`
 * from the closed {@link WORK_FORM_FIELD_TYPES} set, and a boolean `required`. All failures are
 * collected so a caller sees every problem at once, then thrown together.
 */
export function validateFieldDefs(raw: unknown): readonly WorkFormFieldDef[] {
  const details: { field: string; message: string }[] = [];

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'fields', message: 'must be a non-empty array of field definitions' },
    ]);
  }
  if (raw.length > MAX_FIELDS) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'fields', message: `must have ${MAX_FIELDS} fields or fewer` },
    ]);
  }

  const fields: WorkFormFieldDef[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const at = `fields[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      details.push({ field: at, message: 'must be an object' });
      return;
    }
    const candidate = entry as { label?: unknown; type?: unknown; required?: unknown };
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    if (label === '') {
      details.push({ field: `${at}.label`, message: 'must be a non-empty string' });
    } else if (label.length > MAX_LABEL_LENGTH) {
      details.push({
        field: `${at}.label`,
        message: `must be ${MAX_LABEL_LENGTH} characters or fewer`,
      });
    } else if (seen.has(label)) {
      details.push({ field: `${at}.label`, message: 'must be unique within the form' });
    } else {
      seen.add(label);
    }
    if (!isFieldType(candidate.type)) {
      details.push({
        field: `${at}.type`,
        message: `must be one of ${WORK_FORM_FIELD_TYPES.join(', ')}`,
      });
    }
    if (typeof candidate.required !== 'boolean') {
      details.push({ field: `${at}.required`, message: 'must be a boolean' });
    }

    if (label !== '' && isFieldType(candidate.type) && typeof candidate.required === 'boolean') {
      fields.push({ label, type: candidate.type, required: candidate.required });
    }
  });

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return fields;
}

/**
 * Validate a submission's `values` against a form's field definitions, or throw 400.
 *
 * A `values` object maps a field's label to its value. Every `required` field must be present and
 * non-empty; every present value must match its field's type (a `number` is a finite number, a
 * `checkbox` a boolean, a `date` an ISO-8601 date-time, a `text` a string). Values for labels the
 * form does not define are rejected so a submission cannot smuggle undeclared data. All failures are
 * collected and thrown together, before any work item is created.
 */
export function validateSubmissionValues(
  fields: readonly WorkFormFieldDef[],
  rawValues: unknown,
): void {
  if (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'values', message: 'must be an object mapping field labels to values' },
    ]);
  }
  const values = rawValues as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const known = new Set(fields.map((field) => field.label));

  for (const key of Object.keys(values)) {
    if (!known.has(key)) {
      details.push({ field: `values.${key}`, message: 'is not a field on this form' });
    }
  }

  for (const field of fields) {
    const present = Object.hasOwn(values, field.label);
    const value = values[field.label];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '');

    if (field.required && (!present || empty)) {
      details.push({ field: `values.${field.label}`, message: 'is required' });
      continue;
    }
    if (!present || empty) continue;

    switch (field.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          details.push({ field: `values.${field.label}`, message: 'must be a number' });
        }
        break;
      case 'checkbox':
        if (typeof value !== 'boolean') {
          details.push({ field: `values.${field.label}`, message: 'must be a boolean' });
        }
        break;
      case 'date':
        if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
          details.push({
            field: `values.${field.label}`,
            message: 'must be an ISO-8601 date-time string',
          });
        }
        break;
      case 'text':
        if (typeof value !== 'string') {
          details.push({ field: `values.${field.label}`, message: 'must be a string' });
        }
        break;
    }
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
}
