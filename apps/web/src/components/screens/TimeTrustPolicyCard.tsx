'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IDLE_CAP_MAX_HOURS, IDLE_CAP_MIN_HOURS } from '@tmanage/domain';
import { Button, Checkbox, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  readTimeTrustPolicy,
  saveTimeTrustPolicy,
  timeTrustKey,
  type HandTimeCountMode,
  type TimeTrustPolicy,
} from '../../lib/api/time-trust';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import './download-scan-policy.css';

export interface TimeTrustPolicyCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** Only the company owner may change the rules; admins read them. */
  readonly isOwner: boolean;
}

type Draft = Partial<Omit<TimeTrustPolicy, 'mayChange'>>;

const CAP_HOURS: readonly number[] = Array.from(
  { length: IDLE_CAP_MAX_HOURS - IDLE_CAP_MIN_HOURS + 1 },
  (_, i) => IDLE_CAP_MIN_HOURS + i,
);

/**
 * Time you can trust (owner rule, 2026-11-23) — Admin > Time, beside the timer rounding. Three
 * rules: may members add time by hand (off by default), how that time counts (only after a
 * manager approves it, the default, or at once with a label), and when a forgotten timer stops.
 * Same shape as the other time cards: Save and Cancel, owner only; the API checks the owner and
 * writes the audit row with the before and after of each rule.
 */
export function TimeTrustPolicyCard({
  organizationSlug,
  client,
  isOwner,
}: TimeTrustPolicyCardProps) {
  const tr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const titleId = useId();
  const current = useQuery({
    queryKey: timeTrustKey(organizationSlug),
    queryFn: () => readTimeTrustPolicy(client, organizationSlug),
  });
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState(false);
  const stored = current.data;
  const handTimeAllowed = draft.handTimeAllowed ?? stored?.handTimeAllowed ?? false;
  const countMode = draft.handTimeCountMode ?? stored?.handTimeCountMode ?? 'after_approval';
  const capHours = draft.idleCapHours ?? stored?.idleCapHours ?? 10;
  const dirty =
    stored !== undefined &&
    (handTimeAllowed !== stored.handTimeAllowed ||
      countMode !== stored.handTimeCountMode ||
      capHours !== stored.idleCapHours);

  const save = useMutation({
    mutationFn: () =>
      saveTimeTrustPolicy(client, organizationSlug, {
        handTimeAllowed,
        handTimeCountMode: countMode,
        idleCapHours: capHours,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(timeTrustKey(organizationSlug), next);
      setDraft({});
      setSaved(true);
    },
  });

  const change = (next: Draft) => {
    setSaved(false);
    setDraft((before) => ({ ...before, ...next }));
  };
  const cancel = () => {
    setDraft({});
    setSaved(false);
    save.reset();
  };
  const locked = !isOwner || save.isPending;

  return (
    <section className="tm-dlscan" aria-labelledby={titleId}>
      <h2 id={titleId} className="tm-dlscan__title">
        {tr('TimeTrust.title', 'Time you can trust')}
      </h2>
      <p className="tm-dlscan__intro">
        {tr(
          'TimeTrust.intro',
          'The timer records time itself, and nobody can change it afterwards. Here you decide whether people may also type time in by hand. Reports, payroll exports, invoices and the client portal always show the two apart.',
        )}
      </p>

      {current.isError ? (
        <InlineAlert tone="danger" live>
          {tr('TimeTrust.loadError', 'The setting could not be loaded.')}
        </InlineAlert>
      ) : current.isPending ? (
        <LoadingRegion label={tr('TimeTrust.title', 'Time you can trust')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : (
        <>
          <Checkbox
            label={tr('TimeTrust.handAllowed', 'Members may add time by hand')}
            hint={tr(
              'TimeTrust.handAllowedHint',
              'Off: only the timer adds time. On: time typed in is labelled “Added by hand” and needs a reason.',
            )}
            checked={handTimeAllowed}
            disabled={locked}
            onChange={(event) => change({ handTimeAllowed: event.target.checked })}
          />
          <Select
            label={tr('TimeTrust.countLabel', 'Time added by hand counts')}
            value={countMode}
            disabled={locked || !handTimeAllowed}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'after_approval' || next === 'at_once_flagged') {
                change({ handTimeCountMode: next satisfies HandTimeCountMode });
              }
            }}
          >
            <option value="after_approval">
              {tr('TimeTrust.countAfterApproval', 'Only after a manager approves it (recommended)')}
            </option>
            <option value="at_once_flagged">
              {tr('TimeTrust.countAtOnce', 'At once, marked for a manager to check')}
            </option>
          </Select>
          <Select
            label={tr('TimeTrust.capLabel', 'Stop a forgotten timer after')}
            hint={tr(
              'TimeTrust.capHint',
              'The timer stops at this point and the time waits for a manager. It never counts on its own.',
            )}
            value={String(capHours)}
            disabled={locked}
            onChange={(event) => change({ idleCapHours: Number(event.target.value) })}
          >
            {CAP_HOURS.map((hours) => (
              <option key={hours} value={hours}>
                {pluralPhrase(tr, locale, 'TimeTrust.capHours', hours, {
                  one: '{count} hour',
                  other: '{count} hours',
                })}
              </option>
            ))}
          </Select>

          {isOwner ? (
            <>
              {save.isError ? (
                <InlineAlert tone="danger" live>
                  {tr('TimeTrust.saveError', 'The setting was not saved. Try again.')}
                </InlineAlert>
              ) : null}
              {saved && !dirty ? (
                <InlineAlert tone="success" live>
                  {tr('TimeTrust.saved', 'Saved.')}
                </InlineAlert>
              ) : null}
              <hr className="tm-dlscan__rule" />
              <div className="tm-dlscan__footer">
                <Button
                  type="button"
                  tone="outline"
                  onClick={cancel}
                  disabled={save.isPending || !dirty}
                >
                  {tr('TimeTrust.cancel', 'Cancel')}
                </Button>
                <Button
                  type="button"
                  tone="ink"
                  loading={save.isPending}
                  loadingLabel={tr('TimeTrust.saving', 'Saving')}
                  disabled={!dirty}
                  onClick={() => save.mutate()}
                >
                  {tr('TimeTrust.save', 'Save')}
                </Button>
              </div>
            </>
          ) : (
            <InlineAlert tone="neutral">
              {tr('TimeTrust.ownerOnly', 'Only the company owner can change this.')}
            </InlineAlert>
          )}
        </>
      )}
    </section>
  );
}
