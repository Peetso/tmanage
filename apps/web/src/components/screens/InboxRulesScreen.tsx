'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/inbox.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  INBOX_RULE_CATEGORIES,
  INBOX_RULE_MATCH_TYPES,
  createInboxRule,
  deleteInboxRule,
  listInboxRules,
} from '../../lib/api/inbox-rules';
import type {
  InboxRuleCategory,
  InboxRuleMatchType,
  InboxRuleView,
} from '../../lib/api/inbox-rules';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface InboxRulesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Message keys for the two match fields, keyed by the value the API validates against. */
const MATCH_TYPE_LABEL_KEYS: Record<InboxRuleMatchType, MessageKey> = {
  type: 'InboxRulesScreen.matchTypeNotification',
  object_type: 'InboxRulesScreen.matchTypeAbout',
};

/** Message keys for the category a rule applies, keyed by the value the API validates against. */
const CATEGORY_LABEL_KEYS: Record<InboxRuleCategory, MessageKey> = {
  urgent: 'InboxRulesScreen.categoryUrgent',
  follow_up: 'InboxRulesScreen.categoryFollowUp',
  waiting: 'InboxRulesScreen.categoryWaiting',
  fyi: 'InboxRulesScreen.categoryFyi',
  archive: 'InboxRulesScreen.categoryArchive',
};

/**
 * **Inbox routing rules (module Inbox, x301).**
 *
 * `22-SCREEN-BY-SCREEN` §Inbox; `38-MODULE-MAP` §Inbox. The inbox has snooze, flags and saved filters
 * but no per-user way to route notifications; this is the panel that adds it. A member reads their own
 * ordered rules, adds a rule (when a notification's type or object matches a value, apply a category),
 * and removes one — all behind `work.read`, scoped to the caller's own membership by the server. The
 * `matchType` and `category` are each a fixed allowlist validated on both sides; rules are applied
 * read-side and never change a notification.
 */
export function InboxRulesScreen({
  organizationSlug,
  organizationName,
  client,
}: InboxRulesScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const queryKey = ['inbox-rules', organizationSlug];

  const rules = useQuery({
    queryKey,
    queryFn: () => listInboxRules(api, organizationSlug),
  });

  const [matchType, setMatchType] = useState<InboxRuleMatchType>('object_type');
  const [matchValue, setMatchValue] = useState('');
  const [category, setCategory] = useState<InboxRuleCategory>('urgent');

  const invalidate = () => queries.invalidateQueries({ queryKey });

  const add = useMutation({
    mutationFn: (): Promise<InboxRuleView> =>
      createInboxRule(api, organizationSlug, {
        matchType,
        matchValue: matchValue.trim(),
        category,
        position: rules.data?.length ?? 0,
      }),
    onSuccess: () => {
      setMatchValue('');
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> => deleteInboxRule(api, organizationSlug, id),
    onSuccess: () => void invalidate(),
  });

  const canAdd = matchValue.trim().length > 0 && !add.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      eyebrow={t('InboxRulesScreen.eyebrow')}
      title={t('InboxRulesScreen.title')}
      description={t('InboxRulesScreen.description')}
    >
      {rules.isPending ? (
        <LoadingRegion label={t('InboxRulesScreen.loading')}>
          <Skeleton height="160px" />
        </LoadingRegion>
      ) : rules.isError ? (
        <InlineAlert tone="danger" title={t('InboxRulesScreen.loadErrorTitle')}>
          {errorMessage(rules.error)}
        </InlineAlert>
      ) : (
        <div className="tm-inbox-rules">
          <form
            className="tm-card"
            aria-labelledby="tm-inbox-rules-add-heading"
            onSubmit={(event) => {
              event.preventDefault();
              if (canAdd) add.mutate();
            }}
          >
            <p className="tm-inbox-eyebrow">{t('InboxRulesScreen.newRuleEyebrow')}</p>
            <h2 id="tm-inbox-rules-add-heading" className="tm-card__title">
              {t('InboxRulesScreen.addHeading')}
            </h2>

            <div className="tm-inbox-rules__sentence">
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-inbox-rule-match-type">
                  {t('InboxRulesScreen.whenThe')}
                </label>
                <select
                  id="tm-inbox-rule-match-type"
                  className="tm-field__control"
                  value={matchType}
                  onChange={(event) => setMatchType(event.target.value as InboxRuleMatchType)}
                >
                  {INBOX_RULE_MATCH_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {t(MATCH_TYPE_LABEL_KEYS[value])}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-inbox-rule-match-value">
                  {t('InboxRulesScreen.matches')}
                </label>
                <input
                  id="tm-inbox-rule-match-value"
                  className="tm-field__control"
                  type="text"
                  value={matchValue}
                  maxLength={190}
                  onChange={(event) => setMatchValue(event.target.value)}
                />
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-inbox-rule-category">
                  {t('InboxRulesScreen.labelIt')}
                </label>
                <select
                  id="tm-inbox-rule-category"
                  className="tm-field__control"
                  value={category}
                  onChange={(event) => setCategory(event.target.value as InboxRuleCategory)}
                >
                  {INBOX_RULE_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {t(CATEGORY_LABEL_KEYS[value])}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {add.isError ? (
              <InlineAlert tone="danger" title={t('InboxRulesScreen.addErrorTitle')}>
                {errorMessage(add.error)}
              </InlineAlert>
            ) : null}

            <div>
              <Button type="submit" disabled={!canAdd}>
                {add.isPending ? t('InboxRulesScreen.adding') : t('InboxRulesScreen.addButton')}
              </Button>
            </div>
          </form>

          <section className="tm-card" aria-labelledby="tm-inbox-rules-list-heading">
            <div className="tm-section-head">
              <h2 id="tm-inbox-rules-list-heading" className="tm-card__title">
                {t('InboxRulesScreen.listHeading')}
              </h2>
              <span className="tm-section-head__meta">
                {`${rules.data.length} ${
                  rules.data.length === 1
                    ? t('InboxRulesScreen.ruleWord')
                    : t('InboxRulesScreen.rulesWord')
                }`}
              </span>
            </div>
            {rules.data.length === 0 ? (
              <div className="tm-inbox-caught-up">
                <span className="tm-inbox-orb tm-inbox-orb--quiet" aria-hidden="true">
                  ✓
                </span>
                <p className="tm-inbox-caught-up__text">{t('InboxRulesScreen.empty')}</p>
              </div>
            ) : (
              <ul className="tm-inbox-rule-list" aria-label={t('InboxRulesScreen.listLabel')}>
                {rules.data.map((rule, index) => (
                  <li className="tm-inbox-rule" key={rule.id}>
                    <span className="tm-inbox-rule__index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="tm-inbox-rule__text">
                      {t(MATCH_TYPE_LABEL_KEYS[rule.matchType])} “{rule.matchValue}” →{' '}
                      {t(CATEGORY_LABEL_KEYS[rule.category])}
                    </span>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={remove.isPending}
                      aria-label={`${t('InboxRulesScreen.removeRulePrefix')} ${rule.matchValue}`}
                      onClick={() => remove.mutate(rule.id)}
                    >
                      {t('InboxRulesScreen.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {remove.isError ? (
              <InlineAlert tone="danger" title={t('InboxRulesScreen.removeErrorTitle')}>
                {errorMessage(remove.error)}
              </InlineAlert>
            ) : null}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
