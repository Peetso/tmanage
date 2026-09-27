'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="IP allowlist"
      description="Record the network ranges your organization trusts."
    >
      <InlineAlert tone="neutral" title="Advisory list — not yet enforced">
        These ranges are recorded for reference only. Requests are not yet refused by source IP;
        enforcement in the sign-in path is a later change.
      </InlineAlert>

      <section className="tm-panel tm-stack" aria-labelledby="tm-allowlist-add-heading">
        <h2 id="tm-allowlist-add-heading" className="tm-eyebrow">
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
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-allowlist-list-heading"
      >
        <h2 id="tm-allowlist-list-heading" className="tm-eyebrow">
          Ranges {entries.isSuccess ? `(${rows.length})` : ''}
        </h2>

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
          <InlineAlert tone="neutral" title="No ranges yet">
            Add a range above to record a network your organization trusts.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              The organization&rsquo;s advisory IP allowlist.
            </caption>
            <thead>
              <tr>
                <th scope="col">Range</th>
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
                    <code>{entry.cidr}</code>
                  </td>
                  <td>{entry.label ?? '—'}</td>
                  <td>
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
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
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
