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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

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
      crumbs={['Security', 'IP ranges']}
      title="Where the studio works from"
      {...(entries.isSuccess
        ? { titleMeta: `${rows.length} ${rows.length === 1 ? 'range' : 'ranges'}` }
        : {})}
    >
      <div className="tm-cc-split tm-cc-split--even">
        <div className="tm-cc-column">
          <section className="tm-cc-card" aria-labelledby="tm-allowlist-add-heading">
            <h2 id="tm-allowlist-add-heading" className="tm-cc-card__title">
              Add a range
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
                label="IP address or CIDR range"
                name="cidr"
                value={cidr}
                onChange={(event) => setCidr(event.target.value)}
                hint="An IPv4/IPv6 address or CIDR block, e.g. 203.0.113.0/24."
                required
              />
              <Field
                label="Label"
                name="label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                hint="Optional — e.g. Head office VPN."
              />

              {add.isError ? (
                <InlineAlert tone="danger" title="Could not add the range" live>
                  {describeError(add.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={add.isPending}
                  loadingLabel="Adding"
                  disabled={!canAdd}
                >
                  Add range
                </Button>
              </div>
            </form>
          </section>

          <section
            className="tm-cc-card tm-cc-card--attention"
            aria-labelledby="tm-allowlist-advisory"
          >
            <p className="tm-cc-eyebrow tm-cc-eyebrow--warning">Advisory list</p>
            <h2 id="tm-allowlist-advisory" className="tm-cc-card__title">
              Not yet enforced
            </h2>
            <p className="tm-cc-card__body">
              These ranges are recorded for reference only. Requests are not yet refused by source
              IP; enforcement in the sign-in path is a later change.
            </p>
          </section>
        </div>

        <section
          className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
          aria-labelledby="tm-allowlist-list-heading"
        >
          <h2 id="tm-allowlist-list-heading" className="tm-visually-hidden">
            Ranges {entries.isSuccess ? `(${rows.length})` : ''}
          </h2>

          {entries.isError || remove.isError || entries.isPending || rows.length === 0 ? (
            <div className="tm-cc-card__inset tm-stack">
              {entries.isError ? (
                <InlineAlert tone="danger" title="Could not load the allowlist" live>
                  {describeError(entries.error)}
                </InlineAlert>
              ) : null}

              {remove.isError ? (
                <InlineAlert tone="danger" title="Could not remove the range" live>
                  {describeError(remove.error)}
                </InlineAlert>
              ) : null}

              {entries.isPending ? (
                <LoadingRegion label="Loading the allowlist.">
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {entries.isSuccess && rows.length === 0 ? (
                <>
                  <p className="tm-cc-eyebrow">Ranges · 0</p>
                  <p className="tm-cc-card__title">No ranges yet</p>
                  <p className="tm-cc-card__body">
                    Add a range to record a network your organization trusts. Until then the studio
                    works from anywhere.
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          {rows.length > 0 ? (
            <table className="tm-table tm-cc-table">
              <caption className="tm-visually-hidden">
                The organization&rsquo;s advisory IP allowlist.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Ranges · {rows.length}</th>
                  <th scope="col">Label</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">Actions</span>
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
                        loadingLabel="Removing"
                        onClick={() => remove.mutate(entry)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </ControlCenterShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
