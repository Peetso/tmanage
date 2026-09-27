'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readSecuritySettings, setSecuritySettings } from '../../lib/api/admin-security';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminSecurityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Organization security settings (Administration module 18, x176).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (security config). This screen reads the organization's
 * security posture — whether a second factor is enforced and an IP allowlist of permitted source
 * networks — and sets it. It is the config surface only: the API stores the posture; refusing a login
 * by IP or requiring a second factor is a later identity slice (NEXT-SCOPES-13), so nothing here can
 * lock an administrator out of their own organization while they are still choosing the values.
 *
 * The allowlist editor validates every entry as an IP/CIDR before it lets the form save, and surfaces
 * the API's refusal if the server rejects one besides — the server is the authoritative boundary
 * (`cidr.ts`), so a malformed entry never persists even if the client check were bypassed.
 */
export function AdminSecurityScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminSecurityScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ['admin-security', organizationSlug],
    queryFn: () => readSecuritySettings(api, organizationSlug),
  });

  const [enforce2fa, setEnforce2fa] = useState(false);
  const [allowlistText, setAllowlistText] = useState('');
  const [saved, setSaved] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed the editable form from the loaded posture once it arrives, without clobbering later edits.
  useEffect(() => {
    if (!settings.data || seeded) return;
    setEnforce2fa(settings.data.enforce2fa);
    setAllowlistText(settings.data.ipAllowlist.join(', '));
    setSeeded(true);
  }, [settings.data, seeded]);

  const entries = splitEntries(allowlistText);
  const invalid = entries.filter((entry) => !isPlausibleEntry(entry));
  const allowlistError =
    invalid.length > 0 ? `Not a valid IP address or CIDR range: ${invalid.join(', ')}` : undefined;

  const save = useMutation({
    mutationFn: () =>
      setSecuritySettings(api, organizationSlug, { enforce2fa, ipAllowlist: entries }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin-security', organizationSlug] });
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Security settings"
      description="Organization-wide security policy. Changes apply to everyone in this organization."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-admin-security-heading">
        <h2 id="tm-admin-security-heading" className="tm-eyebrow">
          Security
        </h2>

        {settings.isError ? (
          <InlineAlert tone="danger" title="Could not load the security settings" live>
            {describeError(settings.error)}
          </InlineAlert>
        ) : null}

        {settings.isPending ? (
          <LoadingRegion label="Loading the security settings.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!settings.isPending && !settings.isError ? (
          <form
            className="tm-stack"
            noValidate
            aria-label="Security settings"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              setSaved(false);
              if (!allowlistError && !save.isPending) save.mutate();
            }}
          >
            <Switch
              label="Require two-factor authentication"
              hint="Every member must enrol a second factor. Enforcement in the sign-in path is coming in a later release; this records the policy now."
              checked={enforce2fa}
              disabled={save.isPending}
              onChange={(event) => {
                setSaved(false);
                setEnforce2fa(event.target.checked);
              }}
            />

            <Field
              label="IP allowlist"
              name="ip-allowlist"
              value={allowlistText}
              onChange={(event) => {
                setSaved(false);
                setAllowlistText(event.target.value);
              }}
              hint="IP addresses or CIDR ranges, comma-separated, e.g. 203.0.113.0/24, 2001:db8::/32. Leave empty for no restriction."
              error={allowlistError}
              disabled={save.isPending}
            />

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save the security settings" live>
                {describeError(save.error)}
              </InlineAlert>
            ) : null}
            {saved && !save.isPending && !save.isError ? (
              <InlineAlert tone="success" title="Saved" live>
                Security settings have been updated for the whole organization.
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                disabled={Boolean(allowlistError)}
                loading={save.isPending}
                loadingLabel="Saving"
              >
                Save
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

/** Split the editor text into entries on newlines and commas, trimmed, blanks dropped. */
function splitEntries(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * A light client-side plausibility check for immediate feedback — a valid IPv4/IPv6 address or CIDR.
 * The API's `cidr.ts` is the authoritative boundary; this only spares the round trip for an obvious
 * typo and never has the last word on what persists.
 */
function isPlausibleEntry(entry: string): boolean {
  const slash = entry.indexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  if (slash !== -1) {
    const prefix = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefix)) return false;
    const max = address.includes(':') ? 128 : 32;
    if (Number(prefix) > max) return false;
  }
  return isPlausibleIpv4(address) || isPlausibleIpv6(address);
}

function isPlausibleIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith('0')) return false;
    return Number(part) <= 255;
  });
}

function isPlausibleIpv6(address: string): boolean {
  if (!address.includes(':')) return false;
  if ((address.match(/::/g) ?? []).length > 1) return false;
  return /^[0-9a-fA-F:.]+$/.test(address);
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
