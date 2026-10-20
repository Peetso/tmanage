'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readSecuritySettings, setSecuritySettings } from '../../lib/api/admin-security';
import { listOrgSessions } from '../../lib/api/admin-sessions';
import { shortDevice, sinceLabel } from '../admin/format';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminSecurityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Organization security settings** — ADM-08 "How people get in" (Administration module 18, x176).
 *
 * The left card is the sign-in posture the API stores — whether a second factor is required — and
 * saves it, carrying the stored IP allowlist through unchanged. Trusted network ranges have their
 * own screen (`/admin/ip-allowlist`), linked here, so the ranges are edited in one place rather than
 * duplicated on this form. The right column is ADM-08's "one thing to look at" (drawn only when the
 * posture gives a reason) and the live list of active sessions from `GET …/admin/sessions`.
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

  const sessions = useQuery({
    queryKey: ['admin-sessions', organizationSlug],
    queryFn: () => listOrgSessions(api, organizationSlug),
  });

  const [enforce2fa, setEnforce2fa] = useState(false);
  const [saved, setSaved] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed the editable form from the loaded posture once it arrives, without clobbering later edits.
  useEffect(() => {
    if (!settings.data || seeded) return;
    setEnforce2fa(settings.data.enforce2fa);
    setSeeded(true);
  }, [settings.data, seeded]);

  const save = useMutation({
    // Trusted network ranges are managed on their own screen; this save carries the stored list
    // through unchanged so saving the 2FA posture never clears it.
    mutationFn: () =>
      setSecuritySettings(api, organizationSlug, {
        enforce2fa,
        ipAllowlist: settings.data?.ipAllowlist ?? [],
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin-security', organizationSlug] });
    },
  });

  const sessionRows = Array.isArray(sessions.data) ? sessions.data : [];
  const loaded = settings.isSuccess;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="security"
      crumbs={['Security']}
      title="How people get in"
      actions={
        <Link
          href={`/${organizationSlug}/admin/audit`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          Security events in the audit log
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-admin-security-heading">
          <h2 id="tm-admin-security-heading" className="tm-visually-hidden">
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
                if (!save.isPending) save.mutate();
              }}
            >
              <ul className="tm-cc-rows">
                <li>
                  <Switch
                    label="Require two-factor authentication"
                    hint="Every member must enrol a second factor to sign in."
                    checked={enforce2fa}
                    disabled={save.isPending}
                    onChange={(event) => {
                      setSaved(false);
                      setEnforce2fa(event.target.checked);
                    }}
                  />
                  <span className={enforce2fa ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'}>
                    {enforce2fa ? 'On' : 'Off'}
                  </span>
                </li>
                <li>
                  <div className="tm-cc-rows__text">
                    <p className="tm-cc-rows__title">Session length</p>
                    <p className="tm-cc-rows__sub">
                      How long a sign-in lasts before it is asked again
                    </p>
                  </div>
                  <Link
                    href={`/${organizationSlug}/policies`}
                    className="tm-button tm-button--outline tm-button--compact"
                  >
                    Edit
                  </Link>
                </li>
                <li>
                  <div className="tm-cc-rows__text">
                    <p className="tm-cc-rows__title">Trusted network ranges</p>
                    <p className="tm-cc-rows__sub">Record the networks your studio works from</p>
                  </div>
                  <Link
                    href={`/${organizationSlug}/admin/ip-allowlist`}
                    className="tm-button tm-button--outline tm-button--compact"
                  >
                    Ranges
                  </Link>
                </li>
              </ul>

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
                  loading={save.isPending}
                  loadingLabel="Saving"
                >
                  Save
                </Button>
              </div>
            </form>
          ) : null}
        </section>

        <div className="tm-cc-column">
          {loaded && !settings.data.enforce2fa ? (
            <section
              className="tm-cc-card tm-cc-card--attention"
              aria-labelledby="tm-admin-security-look"
            >
              <p className="tm-cc-eyebrow tm-cc-eyebrow--warning">One thing to look at</p>
              <h2 id="tm-admin-security-look" className="tm-cc-card__lead">
                Two-factor sign-in is not required, so one stolen password is enough to get in
              </h2>
              <p className="tm-cc-card__body">
                Turning it on records the policy for everyone in this organization. Members enrol
                their second factor from their own preferences.
              </p>
            </section>
          ) : null}

          <section
            className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
            aria-label="Active sessions"
          >
            <table className="tm-table tm-cc-table" aria-label="Active sessions">
              <thead>
                <tr>
                  <th scope="col">
                    Active sessions{sessions.isSuccess ? ` · ${sessionRows.length}` : ''}
                  </th>
                  <th scope="col" className="tm-cc-end">
                    Last seen
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessionRows.slice(0, 6).map((session) => (
                  <tr key={session.sessionId}>
                    <td>
                      <span className="tm-cc-cell-title">
                        {session.memberName} · {shortDevice(session.deviceLabel)}
                      </span>
                      <span className="tm-cc-cell-sub">
                        signed in {formatMoment(session.createdAt)}
                      </span>
                    </td>
                    <td className="tm-cc-end">
                      <span className="tm-cc-cell-mono">{sinceLabel(session.lastSeenAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tm-cc-card__inset tm-row tm-row--between">
              {sessions.isPending ? <p className="tm-cc-note">Loading active sessions…</p> : null}
              {sessions.isError ? (
                <p className="tm-cc-note">{describeError(sessions.error)}</p>
              ) : null}
              {sessions.isSuccess && sessionRows.length === 0 ? (
                <p className="tm-cc-note">Nobody is signed in right now.</p>
              ) : null}
              <Link
                href={`/${organizationSlug}/admin/sessions`}
                className="tm-button tm-button--outline tm-button--compact"
              >
                See every session
              </Link>
            </div>
          </section>
        </div>
      </div>
    </ControlCenterShell>
  );
}

function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
