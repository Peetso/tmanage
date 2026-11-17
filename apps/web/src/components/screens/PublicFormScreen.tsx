'use client';

import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  getPublicForm,
  submitPublicForm,
  type PublicFormDefinition,
  type PublicSubmitResult,
} from '../../lib/api/public-forms';
import { useFormProof } from '../../lib/form-proof';
import { solvePow } from '../../lib/public-form-pow';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import '../../styles/screens/work-forms-public.css';

export interface PublicFormScreenProps {
  readonly slug: string;
  readonly client?: ApiClient;
}

/** The answers a form sends, keyed `f1…fn` as the definition names its fields. */
export type IntakeFormValues = Readonly<Record<string, string | number | boolean>>;

/** How one send ended. */
export type IntakeSendOutcome =
  | { readonly kind: 'failed'; readonly reason: 'invalid' | 'refused' | 'busy' }
  | { readonly kind: 'sent'; readonly reference: string };

type Phase = { readonly kind: 'filling' } | IntakeSendOutcome;

/** What the shared form needs: its definition's load state and a way to send. */
export interface IntakeFormProps {
  readonly definition: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data: PublicFormDefinition | undefined;
  };
  send(values: IntakeFormValues): Promise<IntakeSendOutcome>;
  /** 52-27. Shown inside the client portal: no page landmark or footer, and "back" once sent. */
  readonly embedded?: { readonly backHref: string; readonly backLabel: string };
  /** Hidden inputs a door adds to the form (the public form proof). */
  readonly hidden?: ReactNode;
}

/** A 400 with field details is a wrong answer; without details the studio refused it. */
export function sendFailure(error: unknown): IntakeSendOutcome {
  const reason =
    error instanceof ApiRequestError && (error.status === 400 || error.status === 409)
      ? error.details.length === 0
        ? 'refused'
        : 'invalid'
      : 'busy';
  return { kind: 'failed', reason };
}

/**
 * 2026-10-31 live-test fix — the public page of a shared intake form (`/f/<slug>`).
 *
 * Figma: "Forms · Public form page" 446:36209, "… could not send" 446:36239, "… sent" 446:36268.
 * A visitor needs no account. The page loads the opaque definition, shows one field per question,
 * and sends the answers with the invisible form proof. A held submission that asks for a
 * proof-of-work is solved here, silently, and re-sent; any other challenge (e-mail code,
 * Turnstile) is not offered on this page yet, so the visitor is told to try again later.
 */
export function PublicFormScreen({ slug, client }: PublicFormScreenProps) {
  const api = client ?? browserApiClient();
  const locale = useActiveLocale();
  const formProof = useFormProof(api);

  const definition = useQuery({
    queryKey: ['public-form', slug],
    queryFn: () => getPublicForm(api, slug),
    retry: false,
  });

  const send = async (values: IntakeFormValues): Promise<IntakeSendOutcome> => {
    try {
      const body = {
        values,
        pageLocale: locale.startsWith('ar') ? 'ar' : 'en',
        ...(await formProof.fields()),
      };
      let result: PublicSubmitResult = await submitPublicForm(api, slug, body);
      if ('challenge' in result) {
        const challenge = result.challenge;
        const solution =
          challenge.kind === 'pow' && challenge.salt !== undefined && challenge.bits !== undefined
            ? await solvePow(challenge.salt, challenge.bits)
            : null;
        if (solution === null) return { kind: 'failed', reason: 'busy' };
        result = await submitPublicForm(api, slug, {
          ...body,
          challengeId: challenge.challengeId,
          powSolution: solution,
        });
      }
      return 'reference' in result
        ? { kind: 'sent', reference: result.reference }
        : { kind: 'failed', reason: 'busy' };
    } catch (error) {
      return sendFailure(error);
    }
  };

  return (
    <IntakeForm
      definition={definition}
      send={send}
      hidden={
        <>
          <input type="hidden" name="startedAt" value={formProof.issue?.startedAt ?? ''} />
          <input type="hidden" name="nonce" value={formProof.issue?.nonce ?? ''} />
        </>
      }
    />
  );
}

/**
 * The intake form itself — the public page's card, also shown by a 52-27 portal journey form step
 * (`embedded`). One field per question; the answers go to whichever door `send` names.
 */
export function IntakeForm({ definition, send, embedded, hidden }: IntakeFormProps) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'filling' });

  const form = definition.data;

  const payload = (fields: PublicFormDefinition['fields']) => {
    const out: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      if (field.type === 'checkbox') {
        out[field.key] = checks[field.key] ?? false;
        continue;
      }
      const raw = (values[field.key] ?? '').trim();
      if (raw === '') continue;
      if (field.type === 'number') out[field.key] = Number(raw);
      else if (field.type === 'date') out[field.key] = new Date(raw).toISOString();
      else out[field.key] = raw;
    }
    return out;
  };

  const submit = async (current: PublicFormDefinition) => {
    setSending(true);
    try {
      const outcome = await send(payload(current.fields));
      setPhase(outcome);
      if (outcome.kind === 'sent') {
        setValues({});
        setChecks({});
      }
    } finally {
      setSending(false);
    }
  };

  const Page = embedded ? 'div' : 'main';
  const footer = embedded ? null : <p className="wf-public__footer">{t('PublicForm.poweredBy')}</p>;

  if (definition.isPending) {
    return (
      <Page className="wf-public">
        <div className="wf-public__card">
          <LoadingRegion label={t('PublicForm.loading')}>
            <Skeleton height="32px" />
            <Skeleton height="44px" />
            <Skeleton height="44px" />
          </LoadingRegion>
        </div>
        {footer}
      </Page>
    );
  }

  if (definition.isError || !form) {
    return (
      <Page className="wf-public">
        <div className="wf-public__card">
          <h1 className="wf-public__title">{t('PublicForm.unavailableTitle')}</h1>
          <p className="wf-public__intro">{t('PublicForm.unavailableBody')}</p>
        </div>
        {footer}
      </Page>
    );
  }

  if (phase.kind === 'sent') {
    return (
      <Page className="wf-public">
        <div className="wf-public__card wf-public__card--sent" role="status" aria-live="polite">
          <h1 className="wf-public__title">{t('PublicForm.sentTitle')}</h1>
          <p className="wf-public__intro">{t('PublicForm.sentBody')}</p>
          <div className="wf-public__reference">
            <span className="wf-public__reference-label">{t('PublicForm.referenceLabel')}</span>
            <span className="wf-public__reference-code">{phase.reference}</span>
            <span className="wf-public__reference-hint">{t('PublicForm.referenceHint')}</span>
          </div>
          <div>
            {embedded ? (
              <Link
                className="tm-button tm-button--default tm-button--ink"
                href={embedded.backHref}
              >
                {embedded.backLabel}
              </Link>
            ) : (
              <Button tone="outline" onClick={() => setPhase({ kind: 'filling' })}>
                {t('PublicForm.sendAnother')}
              </Button>
            )}
          </div>
        </div>
        {footer}
      </Page>
    );
  }

  const missingRequired = form.fields.some(
    (field) =>
      field.required && field.type !== 'checkbox' && (values[field.key] ?? '').trim() === '',
  );

  return (
    <Page className="wf-public">
      <div className="wf-public__card">
        <h1 className="wf-public__title">{form.title}</h1>
        <p className="wf-public__intro">{t('PublicForm.intro')}</p>
        <form
          className="wf-public__form"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (!sending && !missingRequired) void submit(form);
          }}
        >
          {hidden}
          {form.fields.map((field) =>
            field.type === 'checkbox' ? (
              <div key={field.key} className="tm-field tm-field--checkbox wf-public__check">
                <input
                  id={`wf-${field.key}`}
                  type="checkbox"
                  checked={checks[field.key] ?? false}
                  onChange={(event) =>
                    setChecks((current) => ({ ...current, [field.key]: event.target.checked }))
                  }
                />
                <label className="tm-field__label" htmlFor={`wf-${field.key}`}>
                  {field.label}
                </label>
              </div>
            ) : (
              <Field
                key={field.key}
                label={field.required ? `${field.label} *` : field.label}
                name={field.key}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                maxLength={field.maxLength}
                value={values[field.key] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
                required={field.required}
              />
            ),
          )}

          {phase.kind === 'failed' ? (
            <InlineAlert tone="danger" title={t('PublicForm.failedTitle')} live>
              {phase.reason === 'invalid'
                ? t('PublicForm.failedInvalid')
                : phase.reason === 'refused'
                  ? t('PublicForm.failedRefused')
                  : t('PublicForm.failedBusy')}
            </InlineAlert>
          ) : null}

          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={sending}
            loadingLabel={t('PublicForm.sending')}
            disabled={missingRequired}
          >
            {t('PublicForm.send')}
          </Button>
          <p className="wf-public__note">{t('PublicForm.note')}</p>
        </form>
      </div>
      {footer}
    </Page>
  );
}
