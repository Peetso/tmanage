'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import {
  PLATFORM_UNIT_COSTS_QUERY_KEY,
  centsFromInput,
  fetchUnitCosts,
  inputFromCents,
  saveUnitCosts,
} from '../../../lib/api/platform-unit-costs';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { PlatformPageState } from '../shared/PlatformPageState';
import { platformErrorText } from '../shared/ReasonDialog';

/**
 * 62-A3 (B14) — "Unit costs" (platform settings, General, anchor `#unit-costs`): the platform's
 * monthly hosting/storage and mail costs in US dollars. Growth divides them, with the month's AI
 * spend, by the active companies. Until both lines are saved the Growth tile reads "Not set",
 * never 0. The server checks the amounts and writes the audit row.
 */
export const UNIT_COSTS_COPY = {
  title: 'Unit costs',
  body: 'What the platform costs each month. Growth uses these, with the AI spend, for the cost per active company.',
  hosting: 'Hosting and storage',
  mail: 'Mail',
  perMonth: 'US dollars a month',
  invalid: 'Enter an amount such as 29.99.',
  notSet: 'Not set yet. The Growth cost tile stays empty until you save both lines.',
  save: 'Save unit costs',
  loading: 'Loading unit costs',
  loadError: 'The unit costs could not be loaded.',
} as const;

type UnitCostsCopyKey = keyof typeof UNIT_COSTS_COPY;

function useUnitCostsCopy() {
  const tOr = useTOr();
  return useCallback(
    (key: UnitCostsCopyKey) => tOr(`PlatformUnitCosts.${key}`, UNIT_COSTS_COPY[key]),
    [tOr],
  );
}

export function UnitCostsCard({ api, canEdit }: { api: ApiClient; canEdit: boolean }) {
  const t = useT();
  const copy = useUnitCostsCopy();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: PLATFORM_UNIT_COSTS_QUERY_KEY,
    queryFn: () => fetchUnitCosts(api),
  });
  const [hosting, setHosting] = useState('');
  const [mail, setMail] = useState('');
  const [tried, setTried] = useState(false);
  const costs = view.data?.costs ?? null;
  useEffect(() => {
    setHosting(costs === null ? '' : inputFromCents(costs.hostingCentsPerMonth));
    setMail(costs === null ? '' : inputFromCents(costs.mailCentsPerMonth));
  }, [costs]);
  const values = { hosting: centsFromInput(hosting), mail: centsFromInput(mail) };
  const save = useMutation({
    mutationFn: (input: { hostingCentsPerMonth: number; mailCentsPerMonth: number }) =>
      saveUnitCosts(api, input),
    onSuccess: (next) => {
      queryClient.setQueryData(PLATFORM_UNIT_COSTS_QUERY_KEY, next);
      setTried(false);
    },
  });
  const invalid = copy('invalid');

  return (
    <section
      id="unit-costs"
      className="tm-cc-card tm-stack tm-stack--tight"
      aria-labelledby="tm-ps-unit-costs"
    >
      <h2 id="tm-ps-unit-costs" className="tm-cc-card__title">
        {copy('title')}
      </h2>
      <p className="tm-cc-note">{copy('body')}</p>
      {view.isPending ? (
        <PlatformPageState state="loading" loadingLabel={copy('loading')} />
      ) : view.isError ? (
        <PlatformPageState
          state="error"
          error={view.error}
          title={copy('loadError')}
          onRetry={() => void view.refetch()}
        />
      ) : (
        <form
          className="tm-stack tm-stack--tight"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setTried(true);
            if (values.hosting !== null && values.mail !== null) {
              save.mutate({ hostingCentsPerMonth: values.hosting, mailCentsPerMonth: values.mail });
            }
          }}
        >
          {costs === null ? <p className="tm-cc-note">{copy('notSet')}</p> : null}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
              gap: 'var(--s3)',
            }}
          >
            <Field
              label={copy('hosting')}
              hint={copy('perMonth')}
              inputMode="decimal"
              dir="ltr"
              value={hosting}
              disabled={!canEdit}
              onChange={(event) => setHosting(event.target.value)}
              {...(tried && values.hosting === null ? { error: invalid } : {})}
            />
            <Field
              label={copy('mail')}
              hint={copy('perMonth')}
              inputMode="decimal"
              dir="ltr"
              value={mail}
              disabled={!canEdit}
              onChange={(event) => setMail(event.target.value)}
              {...(tried && values.mail === null ? { error: invalid } : {})}
            />
          </div>
          {save.isError ? (
            <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
              {platformErrorText(save.error, t)}
            </InlineAlert>
          ) : null}
          <div>
            <Button
              type="submit"
              tone="ink"
              size="compact"
              disabled={!canEdit}
              loading={save.isPending}
              loadingLabel={t('PlatformShared.working')}
            >
              {copy('save')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
