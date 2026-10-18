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

export interface InboxRulesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Human labels for the two match fields, keyed by the value the API validates against. */
const MATCH_TYPE_LABELS: Record<InboxRuleMatchType, string> = {
  type: 'Notification type',
  object_type: 'About',
};

/** Human labels for the category a rule applies, keyed by the value the API validates against. */
const CATEGORY_LABELS: Record<InboxRuleCategory, string> = {
  urgent: 'Urgent',
  follow_up: 'Follow up',
  waiting: 'Waiting',
  fyi: 'FYI',
  archive: 'Archive',
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
      eyebrow="Inbox"
      title="Inbox rules"
      description="Route your notifications to a category — saved to your account."
    >
      {rules.isPending ? (
        <LoadingRegion label="Loading your inbox rules">
          <Skeleton height="160px" />
        </LoadingRegion>
      ) : rules.isError ? (
        <InlineAlert tone="danger" title="We could not load your inbox rules">
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
            <p className="tm-inbox-eyebrow">New rule</p>
            <h2 id="tm-inbox-rules-add-heading" className="tm-card__title">
              Add a rule
            </h2>

            <div className="tm-inbox-rules__sentence">
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-inbox-rule-match-type">
                  When the
                </label>
                <select
                  id="tm-inbox-rule-match-type"
                  className="tm-field__control"
                  value={matchType}
                  onChange={(event) => setMatchType(event.target.value as InboxRuleMatchType)}
                >
                  {INBOX_RULE_MATCH_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {MATCH_TYPE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-inbox-rule-match-value">
                  matches
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
                  label it
                </label>
                <select
                  id="tm-inbox-rule-category"
                  className="tm-field__control"
                  value={category}
                  onChange={(event) => setCategory(event.target.value as InboxRuleCategory)}
                >
                  {INBOX_RULE_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {CATEGORY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {add.isError ? (
              <InlineAlert tone="danger" title="We could not add the rule">
                {errorMessage(add.error)}
              </InlineAlert>
            ) : null}

            <div>
              <Button type="submit" disabled={!canAdd}>
                {add.isPending ? 'Adding…' : 'Add rule'}
              </Button>
            </div>
          </form>

          <section className="tm-card" aria-labelledby="tm-inbox-rules-list-heading">
            <div className="tm-section-head">
              <h2 id="tm-inbox-rules-list-heading" className="tm-card__title">
                Your rules
              </h2>
              <span className="tm-section-head__meta">
                {rules.data.length === 1 ? '1 rule' : `${rules.data.length} rules`}
              </span>
            </div>
            {rules.data.length === 0 ? (
              <div className="tm-inbox-caught-up">
                <span className="tm-inbox-orb tm-inbox-orb--quiet" aria-hidden="true">
                  ✓
                </span>
                <p className="tm-inbox-caught-up__text">You have no inbox rules yet.</p>
              </div>
            ) : (
              <ul className="tm-inbox-rule-list" aria-label="Inbox rules">
                {rules.data.map((rule, index) => (
                  <li className="tm-inbox-rule" key={rule.id}>
                    <span className="tm-inbox-rule__index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="tm-inbox-rule__text">
                      {MATCH_TYPE_LABELS[rule.matchType]} “{rule.matchValue}” →{' '}
                      {CATEGORY_LABELS[rule.category]}
                    </span>
                    <Button
                      type="button"
                      tone="outline"
                      disabled={remove.isPending}
                      aria-label={`Remove rule for ${rule.matchValue}`}
                      onClick={() => remove.mutate(rule.id)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {remove.isError ? (
              <InlineAlert tone="danger" title="We could not remove the rule">
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
