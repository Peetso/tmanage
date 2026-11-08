'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Field, InlineAlert, Select, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useTOr } from '../../lib/i18n/use-t-or';
import { browserApiClient } from '../../lib/api/browser-client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { listProjects } from '../../lib/api/projects';
import { listMembers } from '../../lib/api/members';
import {
  PM_TARGET_STATES,
  connectPmSource,
  disconnectPmSource,
  discoverPmBoards,
  fetchPmJob,
  previewPmImport,
  startPmImport,
  suggestPmState,
} from '../../lib/api/pm-import';
import type {
  PmBoard,
  PmDiscovery,
  PmImportChoices,
  PmJob,
  PmPreview,
  PmSource,
  PmTargetState,
} from '../../lib/api/pm-import';
import './pm-import.css';

export interface PmImportScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const SOURCE_NAME: Readonly<Record<PmSource, string>> = { trello: 'Trello', asana: 'Asana' };

const STATE_LABEL: Readonly<Record<PmTargetState, [string, string]>> = {
  backlog: ['PmImportScreen.state.backlog', 'Backlog'],
  ready: ['PmImportScreen.state.ready', 'Planned'],
  in_progress: ['PmImportScreen.state.inProgress', 'In progress'],
  internal_review: ['PmImportScreen.state.review', 'In review'],
  done: ['PmImportScreen.state.done', 'Done'],
};

/**
 * **Import from Trello or Asana with your own token** (R45 L3, 54-25; Figma R45 L3 section).
 *
 * Connect (paste the token; it goes to the token vault and is deleted when the import ends) →
 * choose boards and map lists to statuses and members by e-mail → preview (counts, already
 * imported cards are skipped) → the background import, with a link to the shared receipt.
 */
export function PmImportScreen({
  organizationSlug,
  organizationName,
  client,
}: PmImportScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describeError = useDescribeApiError();
  const [source, setSource] = useState<PmSource>('trello');
  const [apiKey, setApiKey] = useState('');
  const [token, setToken] = useState('');
  const [boards, setBoards] = useState<readonly PmBoard[] | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [discovery, setDiscovery] = useState<PmDiscovery | null>(null);
  const [projectId, setProjectId] = useState('');
  const [statusMap, setStatusMap] = useState<Record<string, PmTargetState>>({});
  const [userMap, setUserMap] = useState<Record<string, string | null>>({});
  const [preview, setPreview] = useState<PmPreview | null>(null);
  const [job, setJob] = useState<PmJob | null>(null);

  const projects = useQuery({
    queryKey: ['pm-import-projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    enabled: discovery !== null,
  });
  const members = useQuery({
    queryKey: ['pm-import-members', organizationSlug],
    queryFn: () => listMembers(api, organizationSlug, { limit: 200 }),
    enabled: discovery !== null,
  });

  const choices: PmImportChoices = useMemo(
    () => ({ projectId, boardIds: picked, statusMap, userMap }),
    [projectId, picked, statusMap, userMap],
  );

  const connect = useMutation({
    mutationFn: () =>
      connectPmSource(api, organizationSlug, source, {
        ...(source === 'trello' ? { apiKey: apiKey.trim() } : {}),
        token: token.trim(),
      }),
    onSuccess: (found) => {
      setBoards(found);
      setToken('');
      setApiKey('');
    },
  });
  const discover = useMutation({
    mutationFn: () => discoverPmBoards(api, organizationSlug, source, picked),
    onSuccess: (found) => {
      setDiscovery(found);
      setStatusMap({ ...found.suggestion.statusMap });
      setUserMap({ ...found.suggestion.userMap });
      setPreview(null);
    },
  });
  const previewRun = useMutation({
    mutationFn: () => previewPmImport(api, organizationSlug, source, choices),
    onSuccess: setPreview,
  });
  const start = useMutation({
    mutationFn: () => startPmImport(api, organizationSlug, source, choices),
    onSuccess: setJob,
  });
  const forget = useMutation({
    mutationFn: () => disconnectPmSource(api, organizationSlug, source),
    onSuccess: () => {
      setBoards(null);
      setPicked([]);
      setDiscovery(null);
      setPreview(null);
    },
  });
  const jobState = useQuery({
    queryKey: ['pm-import-job', organizationSlug, job?.jobId],
    queryFn: () => fetchPmJob(api, organizationSlug, source, job?.jobId ?? ''),
    enabled: job !== null,
    refetchInterval: (query) =>
      (query.state.data?.status ?? 'running') === 'running' ? 2000 : false,
  });
  const current = jobState.data ?? job;

  const canConnect =
    token.trim() !== '' && (source === 'asana' || apiKey.trim() !== '') && !connect.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={tOr('PmImportScreen.title', 'Import from Trello or Asana')}
      description={tOr(
        'PmImportScreen.description',
        'Bring cards and tasks in with their comments, due dates and people.',
      )}
    >
      <div className="tm-pmi">
        {boards === null ? (
          <form
            className="tm-pmi__panel"
            aria-label={tOr('PmImportScreen.connectTitle', 'Import from Trello or Asana')}
            onSubmit={(event) => {
              event.preventDefault();
              if (canConnect) connect.mutate();
            }}
          >
            <h2 className="tm-pmi__title">
              {tOr('PmImportScreen.connectTitle', 'Import from Trello or Asana')}
            </h2>
            <div
              className="tm-pmi__row"
              role="group"
              aria-label={tOr('PmImportScreen.sourceLabel', 'Source')}
            >
              {(['trello', 'asana'] as const).map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="compact"
                  tone={source === s ? 'ink' : 'outline'}
                  aria-pressed={source === s}
                  onClick={() => setSource(s)}
                >
                  {SOURCE_NAME[s]}
                </Button>
              ))}
            </div>
            <p className="tm-pmi__muted">
              {tOr(
                'PmImportScreen.connectBody',
                'Paste your own API token. TManage keeps it in the token vault, uses it once for this import and deletes it when the import ends. No app setup needed.',
              )}
            </p>
            {connect.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PmImportScreen.connectError', 'That token did not work')}
                live
              >
                {describeError(connect.error)}
              </InlineAlert>
            ) : null}
            {source === 'trello' ? (
              <Field
                label={tOr('PmImportScreen.apiKey', 'API key')}
                hint={tOr('PmImportScreen.apiKeyHint', 'Only used for this import.')}
                placeholder="trello.com/app-key"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
            ) : null}
            <Field
              label={tOr('PmImportScreen.token', 'Token')}
              hint={tOr('PmImportScreen.tokenHint', 'Deleted when the import ends.')}
              placeholder={tOr('PmImportScreen.tokenPlaceholder', 'Paste your token')}
              type="password"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
            <div className="tm-pmi__row">
              <Button
                tone="ink"
                size="compact"
                type="submit"
                disabled={!canConnect}
                loading={connect.isPending}
                loadingLabel={tOr('PmImportScreen.connecting', 'Connecting')}
              >
                {tOr('PmImportScreen.connect', 'Connect')}
              </Button>
            </div>
          </form>
        ) : null}

        {boards !== null && job === null ? (
          <section className="tm-pmi__panel" aria-labelledby="tm-pmi-map">
            <h2 className="tm-pmi__title" id="tm-pmi-map">
              {tOr('PmImportScreen.mapTitle', 'Choose boards and map them')}
            </h2>
            <h3 className="tm-pmi__eyebrow">{tOr('PmImportScreen.boards', 'Boards')}</h3>
            {boards.length === 0 ? (
              <p className="tm-pmi__muted">
                {tOr('PmImportScreen.noBoards', 'This token can see no boards.')}
              </p>
            ) : (
              <ul className="tm-pmi__list">
                {boards.map((board) => (
                  <li key={board.id}>
                    <Checkbox
                      label={board.group ? `${board.name} · ${board.group}` : board.name}
                      checked={picked.includes(board.id)}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        setPicked((prev) =>
                          on
                            ? [...prev, board.id].slice(0, 10)
                            : prev.filter((id) => id !== board.id),
                        );
                        setDiscovery(null);
                        setPreview(null);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            {discover.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PmImportScreen.readError', 'Could not read the boards')}
                live
              >
                {describeError(discover.error)}
              </InlineAlert>
            ) : null}
            {discovery === null ? (
              <div className="tm-pmi__row">
                <Button
                  tone="ink"
                  size="compact"
                  disabled={picked.length === 0}
                  loading={discover.isPending}
                  loadingLabel={tOr('PmImportScreen.reading', 'Reading boards')}
                  onClick={() => discover.mutate()}
                >
                  {tOr('PmImportScreen.next', 'Next')}
                </Button>
                <Button tone="text" loading={forget.isPending} onClick={() => forget.mutate()}>
                  {tOr('PmImportScreen.forget', 'Forget token')}
                </Button>
              </div>
            ) : (
              <MappingFields
                discovery={discovery}
                projects={projects.data ?? []}
                members={members.data?.members ?? []}
                projectId={projectId}
                statusMap={statusMap}
                userMap={userMap}
                onProject={(id) => {
                  setProjectId(id);
                  setPreview(null);
                }}
                onStatus={(name, state) => {
                  setStatusMap((prev) => ({ ...prev, [name]: state }));
                  setPreview(null);
                }}
                onUser={(key, userId) => {
                  setUserMap((prev) => ({ ...prev, [key]: userId }));
                  setPreview(null);
                }}
              />
            )}
            {discovery !== null && preview === null ? (
              <>
                {previewRun.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={tOr('PmImportScreen.previewError', 'Could not preview this import')}
                    live
                  >
                    {describeError(previewRun.error)}
                  </InlineAlert>
                ) : null}
                <div className="tm-pmi__row">
                  <Button
                    tone="ink"
                    size="compact"
                    disabled={projectId === ''}
                    loading={previewRun.isPending}
                    loadingLabel={tOr('PmImportScreen.previewing', 'Counting cards')}
                    onClick={() => previewRun.mutate()}
                  >
                    {tOr('PmImportScreen.preview', 'Preview')}
                  </Button>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {preview !== null && job === null ? (
          <section className="tm-pmi__panel" aria-labelledby="tm-pmi-preview">
            <h2 className="tm-pmi__title" id="tm-pmi-preview">
              {tOr('PmImportScreen.previewTitle', 'Preview')}
            </h2>
            <dl className="tm-pmi__well tm-pmi__counts">
              <Count
                label={tOr('PmImportScreen.count.cards', 'Cards')}
                value={preview.counts.cards}
              />
              <Count
                label={tOr('PmImportScreen.count.comments', 'Comments')}
                value={
                  preview.counts.comments ??
                  tOr('PmImportScreen.count.commentsLater', 'Counted during import')
                }
              />
              <Count
                label={tOr('PmImportScreen.count.due', 'Due dates')}
                value={preview.counts.dueDates}
              />
              <Count
                label={tOr('PmImportScreen.count.skipped', 'Already imported, skipped')}
                value={preview.counts.alreadyImported}
              />
            </dl>
            <InlineAlert
              tone="neutral"
              title={tOr('PmImportScreen.againTitle', 'Safe to run again')}
            >
              {tOr(
                'PmImportScreen.again',
                'Running this import again skips cards it already brought in.',
              )}
            </InlineAlert>
            {start.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('PmImportScreen.startError', 'The import did not start')}
                live
              >
                {describeError(start.error)}
              </InlineAlert>
            ) : null}
            <div className="tm-pmi__row">
              <Button
                tone="ink"
                size="compact"
                disabled={preview.counts.cards === 0}
                loading={start.isPending}
                loadingLabel={tOr('PmImportScreen.starting', 'Starting')}
                onClick={() => start.mutate()}
              >
                {tOr('PmImportScreen.start', 'Start import')}
              </Button>
              <Button tone="text" onClick={() => setPreview(null)}>
                {tOr('PmImportScreen.back', 'Back')}
              </Button>
            </div>
          </section>
        ) : null}

        {current !== null ? (
          <section className="tm-pmi__panel" aria-live="polite" aria-labelledby="tm-pmi-job">
            <h2 className="tm-pmi__title" id="tm-pmi-job">
              {tOr('PmImportScreen.jobTitle', 'Import')}
            </h2>
            {current.status === 'running' ? (
              <StatusDot tone="live">{tOr('PmImportScreen.running', 'Importing')}</StatusDot>
            ) : current.status === 'failed' ? (
              <InlineAlert tone="danger" title={tOr('PmImportScreen.failed', 'The import stopped')}>
                {tOr(
                  'PmImportScreen.failedBody',
                  'The source could not be read. The token has been deleted; paste it again to retry.',
                )}
              </InlineAlert>
            ) : (
              <>
                <StatusDot tone={current.failedCount > 0 ? 'warning' : 'success'}>
                  {`${tOr('PmImportScreen.imported', 'Imported')} · ${current.committedCount}`}
                </StatusDot>
                <Link
                  className="tm-pmi__link"
                  href={`/${encodeURIComponent(organizationSlug)}/onboarding/import/${encodeURIComponent(current.jobId)}`}
                >
                  {tOr('PmImportScreen.receipt', 'Open the receipt')}
                </Link>
              </>
            )}
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function Count({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="tm-pmi__count">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MappingFields({
  discovery,
  projects,
  members,
  projectId,
  statusMap,
  userMap,
  onProject,
  onStatus,
  onUser,
}: {
  discovery: PmDiscovery;
  projects: readonly { id: string; name: string }[];
  members: readonly { userId: string; displayName: string }[];
  projectId: string;
  statusMap: Readonly<Record<string, PmTargetState>>;
  userMap: Readonly<Record<string, string | null>>;
  onProject: (id: string) => void;
  onStatus: (name: string, state: PmTargetState) => void;
  onUser: (key: string, userId: string | null) => void;
}) {
  const tOr = useTOr();
  const listsId = useId();
  const peopleId = useId();
  return (
    <>
      <Select
        label={tOr('PmImportScreen.project', 'Import into project')}
        value={projectId}
        onChange={(event) => onProject(event.currentTarget.value)}
      >
        <option value="">{tOr('PmImportScreen.pickProject', 'Choose a project')}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <h3 className="tm-pmi__eyebrow" id={listsId}>
        {tOr('PmImportScreen.lists', 'Lists to statuses')}
      </h3>
      <ul className="tm-pmi__well" aria-labelledby={listsId}>
        {discovery.containers.map((name) => (
          <li key={name} className="tm-pmi__map-row">
            <span dir="auto">{name}</span>
            <span aria-hidden="true" className="tm-pmi__arrow">
              →
            </span>
            <Select
              label={name}
              className="tm-pmi__compact-select"
              value={statusMap[name] ?? suggestPmState(name)}
              onChange={(event) => onStatus(name, event.currentTarget.value as PmTargetState)}
            >
              {PM_TARGET_STATES.map((state) => (
                <option key={state} value={state}>
                  {tOr(STATE_LABEL[state][0], STATE_LABEL[state][1])}
                </option>
              ))}
            </Select>
          </li>
        ))}
      </ul>
      {discovery.people.length > 0 ? (
        <>
          <h3 className="tm-pmi__eyebrow" id={peopleId}>
            {tOr('PmImportScreen.people', 'Members by e-mail')}
          </h3>
          <ul className="tm-pmi__well" aria-labelledby={peopleId}>
            {discovery.people.map((person) => {
              const chosen = userMap[person.key] ?? null;
              return (
                <li key={person.key} className="tm-pmi__map-row">
                  <span className="tm-pmi__mono" dir="ltr">
                    {person.email ?? person.name}
                  </span>
                  <Select
                    label={person.name}
                    className="tm-pmi__compact-select"
                    value={chosen ?? ''}
                    onChange={(event) => onUser(person.key, event.currentTarget.value || null)}
                  >
                    <option value="">
                      {tOr('PmImportScreen.unassigned', 'Not matched · unassigned')}
                    </option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                  </Select>
                  {chosen === null ? (
                    <Badge>{tOr('PmImportScreen.unmatched', 'Unassigned')}</Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </>
  );
}
