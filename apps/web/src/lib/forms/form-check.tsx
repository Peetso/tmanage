'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useTOr } from '../i18n/use-t-or';

/**
 * QA-FIX-S (M2 class): the app reports a form's constraints itself, in its own words.
 *
 * Every `<form>` in the web app carries `noValidate` (the lint rule in `eslint.config.js` fails a
 * form without it). The browser's own check is switched off because its bubble is drawn in the
 * browser's language, not the page's, it is not linked to the field, it does not scale with zoom
 * and it blocks the app's own message from ever showing (WCAG 2.2 Understanding 3.3.1, "User agent
 * native HTML form validation"; GOV.UK Design System, Validation: "Turn off HTML5 validation").
 *
 * Most forms check their fields in their own submit handler and keep doing so. This hook is for a
 * form whose markup constraints (`required`, `type="email"`, `min`/`max`) were its only check: the
 * constraints stay in the markup as the single rule, the browser still evaluates them (the
 * Constraint Validation API works with `noValidate`), and the hook turns each failure into a
 * translated message next to the field. A field in error gets `aria-invalid` and is linked to its
 * message by `aria-describedby` (WCAG technique ARIA21), focus moves to the first one, and the
 * message goes as soon as the field is fixed. Nothing is sent while a field is in error.
 *
 * A control is keyed by its `name`, or its `id` when it has no name.
 */

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface FormCheckWords {
  readonly fillIn: string;
  readonly choose: string;
  readonly email: string;
  readonly link: string;
  readonly date: string;
  readonly number: string;
  readonly wholeNumber: string;
  readonly wholeNumberBetween: string;
  readonly wholeNumberAtLeast: string;
  readonly wholeNumberAtMost: string;
  readonly minLength: string;
  readonly format: string;
}

const DATE_TYPES = new Set(['date', 'month', 'week', 'time', 'datetime-local']);

function isControl(element: unknown): element is Control {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  );
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => values[name] ?? whole);
}

function numberMessage(input: HTMLInputElement, words: FormCheckWords): string {
  const whole = input.step === '' || (input.step !== 'any' && Number.isInteger(Number(input.step)));
  if (!whole) return words.number;
  const { min, max } = input;
  if (min !== '' && max !== '') return fill(words.wholeNumberBetween, { min, max });
  if (min !== '') return fill(words.wholeNumberAtLeast, { min });
  if (max !== '') return fill(words.wholeNumberAtMost, { max });
  return words.wholeNumber;
}

/** The control's key: its `name`, or its `id`. */
export function controlKey(control: Control): string {
  return control.name !== '' ? control.name : control.id;
}

/**
 * What to say about one control, read from the browser's own verdict (`validity`). `null` when
 * the control is valid.
 */
export function constraintMessage(control: Control, words: FormCheckWords): string | null {
  const validity = control.validity;
  if (validity.valid) return null;
  const type = control instanceof HTMLInputElement ? control.type : control.localName;
  if (validity.valueMissing) {
    return type === 'select' || type === 'select-one' || type === 'radio' || type === 'checkbox'
      ? words.choose
      : words.fillIn;
  }
  if (validity.typeMismatch) {
    if (type === 'email') return words.email;
    if (type === 'url') return words.link;
    return words.format;
  }
  if (type === 'number' && control instanceof HTMLInputElement)
    return numberMessage(control, words);
  if (DATE_TYPES.has(type)) return words.date;
  if (validity.tooShort && !(control instanceof HTMLSelectElement)) {
    return fill(words.minLength, { min: String(control.minLength) });
  }
  if (validity.customError && control.validationMessage !== '') return control.validationMessage;
  return words.format;
}

/** The translated words, English until a catalog has the key. */
export function useFormCheckWords(): FormCheckWords {
  const tOr = useTOr();
  return useMemo(
    () => ({
      fillIn: tOr('FormCheck.fillIn', 'Fill in this field.'),
      choose: tOr('FormCheck.choose', 'Choose one of the options.'),
      email: tOr('FormCheck.email', 'Enter an email address, like name@example.com.'),
      link: tOr('FormCheck.link', 'Enter a full link that starts with https://'),
      date: tOr('FormCheck.date', 'Enter a complete date.'),
      number: tOr('FormCheck.number', 'Enter a number.'),
      wholeNumber: tOr('FormCheck.wholeNumber', 'Enter a whole number.'),
      wholeNumberBetween: tOr(
        'FormCheck.wholeNumberBetween',
        'Enter a whole number from {min} to {max}.',
      ),
      wholeNumberAtLeast: tOr(
        'FormCheck.wholeNumberAtLeast',
        'Enter a whole number of {min} or more.',
      ),
      wholeNumberAtMost: tOr(
        'FormCheck.wholeNumberAtMost',
        'Enter a whole number of {max} or less.',
      ),
      minLength: tOr('FormCheck.minLength', 'Write at least {min} characters.'),
      format: tOr('FormCheck.format', 'Check what you entered here.'),
    }),
    [tOr],
  );
}

export interface FormCheckOptions {
  /** A form's own sentence for a field, by key. It replaces the generic one for that field. */
  readonly messages?: Readonly<Record<string, string>>;
}

export interface FormCheck {
  /**
   * The form's `onSubmit` and `onChange`. `onValid` runs only when every control passes; the
   * submit's default action is always prevented. The form itself must carry `noValidate`.
   */
  readonly handlers: (onValid: (event: FormEvent<HTMLFormElement>) => void) => {
    readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    readonly onChange: (event: ChangeEvent<HTMLFormElement>) => void;
  };
  /** The message for a control, for a `Field`'s `error` prop. */
  readonly error: (key: string) => string | undefined;
  /** `aria-invalid` and `aria-describedby` for a raw control; `hintId` is kept first. */
  readonly control: (
    key: string,
    hintId?: string,
  ) => { readonly 'aria-invalid'?: true; readonly 'aria-describedby'?: string };
  /** The id of a control's message element. */
  readonly messageId: (key: string) => string;
}

export function useFormCheck(options: FormCheckOptions = {}): FormCheck {
  const words = useFormCheckWords();
  const baseId = useId();
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const focusNext = useRef<Control | null>(null);
  const overrides = options.messages;

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    target?.focus();
  }, [errors]);

  const handlers = useCallback<FormCheck['handlers']>(
    (onValid) => ({
      onSubmit: (event) => {
        event.preventDefault();
        const found: Record<string, string> = {};
        let first: Control | null = null;
        for (const element of Array.from(event.currentTarget.elements)) {
          if (!isControl(element) || !element.willValidate || element.validity.valid) continue;
          const key = controlKey(element);
          if (key === '' || key in found) continue;
          const message = overrides?.[key] ?? constraintMessage(element, words);
          if (message === null) continue;
          found[key] = message;
          first ??= element;
        }
        setErrors(found);
        if (first !== null) {
          focusNext.current = first;
          return;
        }
        onValid(event);
      },
      onChange: (event) => {
        const target = event.target as unknown;
        if (!isControl(target) || !target.validity.valid) return;
        const key = controlKey(target);
        setErrors((current) => {
          if (!(key in current)) return current;
          const rest = { ...current };
          delete rest[key];
          return rest;
        });
      },
    }),
    [overrides, words],
  );

  const messageId = useCallback((key: string) => `${baseId}-${key}-error`, [baseId]);
  const error = useCallback((key: string) => errors[key], [errors]);
  const control = useCallback<FormCheck['control']>(
    (key, hintId) => {
      const invalid = errors[key] !== undefined;
      const describedBy = [hintId, invalid ? messageId(key) : undefined]
        .filter((id): id is string => id !== undefined && id !== '')
        .join(' ');
      return {
        ...(invalid ? { 'aria-invalid': true as const } : {}),
        ...(describedBy !== '' ? { 'aria-describedby': describedBy } : {}),
      };
    },
    [errors, messageId],
  );

  return { handlers, error, control, messageId };
}

/** A raw control's message, styled and placed like `Field`'s own error. */
export function FormCheckMessage({ check, name }: { check: FormCheck; name: string }) {
  const message = check.error(name);
  if (message === undefined) return null;
  return (
    <span className="tm-field__error" id={check.messageId(name)}>
      <span className="tm-inline-alert__glyph" aria-hidden="true">
        !
      </span>
      {message}
    </span>
  );
}
