'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  BUSINESS_FACT_AUDIENCES,
  BUSINESS_FACT_MAX_CHARS,
  decideBusinessFact,
  editBusinessFact,
  proposeBusinessFact,
} from '../../lib/api/business-memory';
import type {
  BusinessFactAudience,
  BusinessFactEntityType,
  BusinessFactView,
} from '../../lib/api/business-memory';
import { useFormCheck } from '../../lib/forms/form-check';
import { inAppHref } from '../ai-chat/ai-chat-model';
import { CloseIcon, FileIcon } from '../ai-chat/icons';
import { useAiText } from '../ai-chat/use-ai-text';
import type { AiTextKey } from '../ai-chat/use-ai-text';
import { factLength } from './business-memory-model';

/** A record a new fact can be about; resolved by the screen from the lists the member can read. */
export interface FactSubject {
  readonly type: BusinessFactEntityType;
  readonly id: string | null;
  readonly name: string;
}

export type FactEditorOutcome = 'saved' | 'added' | 'retired';

export interface FactEditorProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** None: "Add a fact". */
  readonly fact?: BusinessFactView;
  /** The "About" line of an existing fact ("Client · Cedar Foods"). */
  readonly about?: string;
  /** What a new fact can be about (company and way of working first). */
  readonly subjects: readonly FactSubject[];
  readonly onClose: () => void;
  readonly onDone: (outcome: FactEditorOutcome) => void;
}

export const AUDIENCE_LABEL: Record<BusinessFactAudience, AiTextKey> = {
  internal: 'BusinessMemory.audience.internal',
  client_visible: 'BusinessMemory.audience.client_visible',
  finance: 'BusinessMemory.audience.finance',
  hr: 'BusinessMemory.audience.hr',
};

const AUDIENCE_HINT: Record<BusinessFactAudience, AiTextKey> = {
  internal: 'BusinessMemory.audienceHint.internal',
  client_visible: 'BusinessMemory.audienceHint.client_visible',
  finance: 'BusinessMemory.audienceHint.finance',
  hr: 'BusinessMemory.audienceHint.hr',
};

type Fault = 'fact' | 'duplicate' | 'changed' | 'gone' | 'error';

function faultOf(error: unknown): Fault {
  if (!(error instanceof ApiRequestError)) return 'error';
  if (error.status === 400) return 'fact';
  if (error.status === 404) return 'gone';
  if (error.status === 409) return 'changed';
  return 'error';
}

const subjectValue = (subject: FactSubject) => `${subject.type}:${subject.id ?? ''}`;

/**
 * The fact editor (Figma G11 771:47033; review fixes 788:50570 error, 788:50672 audience,
 * 788:50824 retire): one line of at most 500 characters, what it is about, who can see it, the
 * source, and — for an existing fact — "Retire this fact" behind a confirmation. Adding a fact
 * proposes it; a person who manages AI approves it before TManage AI uses it.
 */
export function FactEditor({
  organizationSlug,
  client,
  fact,
  about,
  subjects,
  onClose,
  onDone,
}: FactEditorProps) {
  const { t, number } = useAiText();
  const titleId = useId();
  const firstField = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(fact?.fact ?? '');
  const [audience, setAudience] = useState<BusinessFactAudience>(fact?.audience ?? 'internal');
  const [subject, setSubject] = useState(subjects[0] ? subjectValue(subjects[0]) : '');
  const [retiring, setRetiring] = useState(false);
  const check = useFormCheck({ messages: { fact: t('BusinessMemory.editor.factError') } });

  useEffect(() => {
    firstField.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: async (): Promise<FactEditorOutcome> => {
      const trimmed = text.trim();
      if (fact) {
        const edit = {
          ...(trimmed !== fact.fact ? { fact: trimmed } : {}),
          ...(audience !== fact.audience ? { audience } : {}),
        };
        if (Object.keys(edit).length > 0) {
          await editBusinessFact(client, organizationSlug, fact.id, edit);
        }
        return 'saved';
      }
      const chosen = subjects.find((option) => subjectValue(option) === subject) ?? subjects[0];
      await proposeBusinessFact(client, organizationSlug, {
        entityType: chosen?.type ?? 'company',
        entityId: chosen?.id ?? null,
        fact: trimmed,
        // The API needs a category; the designed editor has none, so a new fact is "other".
        category: 'other',
        audience,
      });
      return 'added';
    },
    onSuccess: (outcome) => onDone(outcome),
  });
  const retire = useMutation({
    mutationFn: () => decideBusinessFact(client, organizationSlug, fact!.id, 'retire'),
    onSuccess: () => onDone('retired'),
  });

  const failed = save.isError ? faultOf(save.error) : retire.isError ? faultOf(retire.error) : null;
  const length = factLength(text);
  const tooLong = length > BUSINESS_FACT_MAX_CHARS;
  const factError =
    failed === 'fact' || tooLong ? t('BusinessMemory.editor.factError') : check.error('fact');

  return (
    <div className="tm-command-palette__backdrop tm-aia-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="tm-aia-editor">
        <div className="tm-aia-editor__head">
          <h2 id={titleId} className="tm-aia-editor__title">
            {fact ? t('BusinessMemory.editor.editTitle') : t('BusinessMemory.editor.addTitle')}
          </h2>
          <button
            type="button"
            className="tm-aia-icon-button"
            aria-label={t('BusinessMemory.editor.close')}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <form
          noValidate
          className="tm-aia-editor__form"
          {...check.handlers(() => {
            if (!tooLong && !save.isPending) save.mutate();
          })}
        >
          <div ref={firstField}>
            <Field
              label={t('BusinessMemory.editor.fact')}
              name="fact"
              required
              autoComplete="off"
              dir="auto"
              value={text}
              onChange={(event) => setText(event.target.value.replace(/[\r\n]+/g, ' '))}
              hint={t('BusinessMemory.editor.counter', {
                count: number(length),
                max: number(BUSINESS_FACT_MAX_CHARS),
              })}
              {...(factError === undefined ? {} : { error: factError })}
            />
          </div>
          {fact ? (
            <Field label={t('BusinessMemory.editor.about')} value={about ?? ''} readOnly />
          ) : (
            <Select
              label={t('BusinessMemory.editor.about')}
              name="about"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            >
              {subjects.map((option) => (
                <option key={subjectValue(option)} value={subjectValue(option)}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            label={t('BusinessMemory.editor.audience')}
            name="audience"
            value={audience}
            hint={t(AUDIENCE_HINT[audience])}
            onChange={(event) => setAudience(event.target.value as BusinessFactAudience)}
          >
            {BUSINESS_FACT_AUDIENCES.map((option) => (
              <option key={option} value={option}>
                {t(AUDIENCE_LABEL[option])}
              </option>
            ))}
          </Select>
          {fact?.sourceHref ? (
            <div className="tm-aia-editor__source">
              <span className="tm-aia-editor__source-label">
                {t('BusinessMemory.editor.source')}
              </span>
              <span className="tm-aia-spacer" />
              <FileIcon />
              <Link href={inAppHref(fact.sourceHref, organizationSlug)} className="tm-aia-link">
                {t('BusinessMemory.editor.openSource')}
              </Link>
            </div>
          ) : null}
          {failed !== null && failed !== 'fact' ? (
            <InlineAlert tone="danger" live>
              {t(
                failed === 'duplicate' || (failed === 'changed' && !fact)
                  ? 'BusinessMemory.editor.duplicate'
                  : failed === 'changed'
                    ? 'BusinessMemory.editor.changed'
                    : failed === 'gone'
                      ? 'BusinessMemory.editor.gone'
                      : 'BusinessMemory.editor.failed',
              )}
            </InlineAlert>
          ) : null}
          {retiring ? (
            <>
              <InlineAlert tone="warning" live>
                {t('BusinessMemory.editor.retireConfirm')}
              </InlineAlert>
              <div className="tm-aia-editor__actions">
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  onClick={() => setRetiring(false)}
                >
                  {t('BusinessMemory.editor.keep')}
                </Button>
                <span className="tm-aia-spacer" />
                <Button
                  type="button"
                  tone="destructive"
                  size="accessible"
                  loading={retire.isPending}
                  onClick={() => retire.mutate()}
                >
                  {t('BusinessMemory.editor.retire')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <hr className="tm-aia-divider" />
              <div className="tm-aia-editor__actions">
                {fact && fact.status !== 'retired' ? (
                  <Button
                    type="button"
                    tone="text"
                    size="accessible"
                    onClick={() => setRetiring(true)}
                  >
                    {t('BusinessMemory.editor.retireThis')}
                  </Button>
                ) : null}
                <span className="tm-aia-spacer" />
                <Button type="button" tone="text" size="accessible" onClick={onClose}>
                  {t('BusinessMemory.editor.cancel')}
                </Button>
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={save.isPending}
                  loadingLabel={t('BusinessMemory.editor.saving')}
                >
                  {fact ? t('BusinessMemory.editor.save') : t('BusinessMemory.editor.add')}
                </Button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
