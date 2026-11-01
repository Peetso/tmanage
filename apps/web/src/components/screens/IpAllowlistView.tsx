'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addIpAllowlistEntry,
  listIpAllowlist,
  removeIpAllowlistEntry,
  type IpAllowlistEntryView,
} from '../../lib/api/admin-ip-allowlist';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { Dialog } from './SecurityScreen';
import '../../styles/screens/access-security.css';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface IpAllowlistViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Organization IP allowlist (Administration module 18, x277).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (security). This screen owns a security admin's advisory list
 * of allowed IP/CIDR ranges — each an address or range with an optional label — and lets them add and
 * remove entries. It is a separate surface from the security-settings screen (x176), which stores the
 * one posture blob.
 *
 * The reads and writes are gated on the server by `org.security.manage`, so a member without it sees
 * the API's 403 rather than a blank page. The list is **advisory only**: this slice records ranges and
 * does not yet refuse a request by source IP — the screen says so explicitly, so no one mistakes it for
 * an active control.
 */
export function IpAllowlistView({
  organizationSlug,
  organizationName,
  client,
}: IpAllowlistViewProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tr = useTOr();
  // 2026-10-31 live test: Remove deleted a range at once. It now asks first (Figma "Admin ·
  // Trusted network ranges · Remove range — confirm (2026-10-31 live-test fix)", 449:21407).
  const [confirming, setConfirming] = useState<IpAllowlistEntryView | null>(null);

  const entries = useQuery({
    queryKey: ['admin-ip-allowlist', organizationSlug],
    queryFn: () => listIpAllowlist(api, organizationSlug),
  });

  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin-ip-allowlist', organizationSlug] });

  const add = useMutation({
    mutationFn: () =>
      addIpAllowlistEntry(api, organizationSlug, {
        cidr: cidr.trim(),
        label: label.trim() === '' ? null : label.trim(),
      }),
    onSuccess: async () => {
      setCidr('');
      setLabel('');
      await invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (entry: IpAllowlistEntryView) =>
      removeIpAllowlistEntry(api, organizationSlug, entry.id),
    onSuccess: async () => {
      setConfirming(null);
      await invalidate();
    },
  });

  const rows = entries.data?.entries ?? [];
  const canAdd = cidr.trim() !== '' && !add.isPending;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="ip-allowlist"
      crumbs={[t('IpAllowlistView.crumbSecurity'), t('IpAllowlistView.crumbIpRanges')]}
      title={t('IpAllowlistView.title')}
      {...(entries.isSuccess
        ? {
            titleMeta: `${rows.length} ${
              rows.length === 1 ? t('IpAllowlistView.rangeWord') : t('IpAllowlistView.rangesWord')
            }`,
          }
        : {})}
    >
      <div className="tm-cc-split tm-cc-split--even">
        <div className="tm-cc-column">
          <section className="tm-cc-card" aria-labelledby="tm-allowlist-add-heading">
            <h2 id="tm-allowlist-add-heading" className="tm-cc-card__title">
              {t('IpAllowlistView.addARange')}
            </h2>
            <form
              className="tm-stack"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canAdd) add.mutate();
              }}
            >
              <Field
                label={t('IpAllowlistView.cidrLabel')}
                name="cidr"
                value={cidr}
                onChange={(event) => setCidr(event.target.value)}
                hint={t('IpAllowlistView.cidrHint')}
                required
              />
              <Field
                label={t('IpAllowlistView.labelLabel')}
                name="label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                hint={t('IpAllowlistView.labelHint')}
              />

              {add.isError ? (
                <InlineAlert tone="danger" title={t('IpAllowlistView.addErrorTitle')} live>
                  {describeError(add.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={add.isPending}
                  loadingLabel={t('IpAllowlistView.adding')}
                  disabled={!canAdd}
                >
                  {t('IpAllowlistView.addRange')}
                </Button>
              </div>
            </form>
          </section>

          <section
            className="tm-cc-card tm-cc-card--attention"
            aria-labelledby="tm-allowlist-advisory"
          >
            <p className="tm-cc-eyebrow tm-cc-eyebrow--warning">
              {t('IpAllowlistView.advisoryList')}
            </p>
            <h2 id="tm-allowlist-advisory" className="tm-cc-card__title">
              {t('IpAllowlistView.forReferenceOnly')}
            </h2>
            <p className="tm-cc-card__body">{t('IpAllowlistView.advisoryBody')}</p>
          </section>
        </div>

        <section
          className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
          aria-labelledby="tm-allowlist-list-heading"
        >
          <h2 id="tm-allowlist-list-heading" className="tm-visually-hidden">
            {t('IpAllowlistView.ranges')} {entries.isSuccess ? `(${rows.length})` : ''}
          </h2>

          {entries.isError || remove.isError || entries.isPending || rows.length === 0 ? (
            <div className="tm-cc-card__inset tm-stack">
              {entries.isError ? (
                <InlineAlert tone="danger" title={t('IpAllowlistView.loadErrorTitle')} live>
                  {describeError(entries.error)}
                </InlineAlert>
              ) : null}

              {remove.isError ? (
                <InlineAlert tone="danger" title={t('IpAllowlistView.removeErrorTitle')} live>
                  {describeError(remove.error)}
                </InlineAlert>
              ) : null}

              {entries.isPending ? (
                <LoadingRegion label={t('IpAllowlistView.loading')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {entries.isSuccess && rows.length === 0 ? (
                <>
                  <p className="tm-cc-eyebrow">{t('IpAllowlistView.ranges')} · 0</p>
                  <p className="tm-cc-card__title">{t('IpAllowlistView.noRangesYet')}</p>
                  <p className="tm-cc-card__body">{t('IpAllowlistView.emptyBody')}</p>
                </>
              ) : null}
            </div>
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table tm-cc-table">
              <caption className="tm-visually-hidden">{t('IpAllowlistView.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">
                    {t('IpAllowlistView.ranges')} · {rows.length}
                  </th>
                  <th scope="col">{t('IpAllowlistView.labelLabel')}</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">{t('IpAllowlistView.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <code className="tm-cc-cell-mono">{entry.cidr}</code>
                    </td>
                    <td>{entry.label ?? '—'}</td>
                    <td className="tm-cc-end">
                      <Button
                        type="button"
                        tone="outline"
                        size="compact"
                        loading={remove.isPending && remove.variables?.id === entry.id}
                        loadingLabel={t('IpAllowlistView.removing')}
                        onClick={() => {
                          remove.reset();
                          setConfirming(entry);
                        }}
                      >
                        {t('IpAllowlistView.remove')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
      {confirming ? (
        <Dialog
          title={tr('IpAllowlistView.confirmTitle', 'Remove {cidr}?').replace(
            '{cidr}',
            confirming.cidr,
          )}
          onClose={() => setConfirming(null)}
        >
          <p className="tm-sec-card__body">
            {confirming.label
              ? tr(
                  'IpAllowlistView.confirmBodyNamed',
                  'People signing in from this range are no longer on the trusted list ({label}). You can add it again at any time.',
                ).replace('{label}', confirming.label)
              : tr(
                  'IpAllowlistView.confirmBody',
                  'People signing in from this range are no longer on the trusted list. You can add it again at any time.',
                )}
          </p>
          {remove.isError ? (
            <InlineAlert tone="danger" title={t('IpAllowlistView.removeErrorTitle')} live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-sec-actions">
            <Button tone="outline" onClick={() => setConfirming(null)}>
              {tr('IpAllowlistView.cancel', 'Cancel')}
            </Button>
            <Button
              tone="destructive"
              loading={remove.isPending}
              loadingLabel={t('IpAllowlistView.removing')}
              onClick={() => remove.mutate(confirming)}
            >
              {tr('IpAllowlistView.confirmRemove', 'Remove range')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </ControlCenterShell>
  );
}
