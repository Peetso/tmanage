'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Field,
  InlineAlert,
  LoadingRegion,
  Select,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { browserApiClient } from '../../lib/api/browser-client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { listProjects, listWorkspaces } from '../../lib/api/projects';
import { commitImport, listImports, undoImport, validateImport } from '../../lib/api/imports';
import type {
  ImportBatchInput,
  ImportJobSummary,
  ImportSourceKind,
  ImportValidationReport,
} from '../../lib/api/imports';
import {
  IMPORT_SOURCE_IDS,
  IMPORT_SOURCES,
  autoMap,
  buildBatch,
  missingRequired,
  parseCsv,
  readBasecampArchive,
} from '../../lib/import-sources';
import type { ImportSourceId } from '../../lib/import-sources';

export interface ImportStartScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** Brand names stay Latin in every locale. */
const SOURCE_NAMES: Readonly<Record<ImportSourceId, string>> = {
  csv: 'CSV',
  jira: 'Jira',
  notion: 'Notion',
  basecamp: 'Basecamp',
  trello: 'Trello',
  asana: 'Asana',
};

const SOURCE_HINTS: Readonly<Record<ImportSourceId, string>> = {
  csv: 'Projects from a spreadsheet',
  jira: 'Issues from a Jira CSV export',
  notion: 'A database exported as CSV',
  basecamp: 'Messages and to-dos from an archive',
  trello: 'Cards from a board CSV',
  asana: 'Tasks from a project CSV',
};

const KIND_NAMES: Readonly<Record<ImportSourceKind, string>> = {
  project: 'CSV',
  jira_issues: 'Jira',
  notion_database: 'Notion · Trello · Asana',
  basecamp_messages: 'Basecamp',
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  targetDate: 'Target date',
  issueKey: 'Issue key',
  summary: 'Summary',
  issueType: 'Issue type',
  status: 'Status',
  statusCategory: 'Status category',
  priority: 'Priority',
  assigneeEmail: 'Assignee',
  sprint: 'Sprint',
  parent: 'Parent',
  description: 'Description',
  created: 'Created',
  dueDate: 'Due date',
  person: 'Assignee',
  date: 'Due date',
  tags: 'Tags',
};

interface LoadedFile {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly truncated: boolean;
}

/**
 * **Import start** (R31 A11) — ON-09 / ADM-10: choose a source (CSV, Jira, Notion, Basecamp,
 * Trello, Asana), upload the export, match its columns, check it (`POST …/imports/validations`,
 * nothing saved), start it (`POST …/imports/commits`, then the receipt screen), and see recent
 * imports with their receipt and the 7-day undo (`GET …/imports`, `POST …/imports/:jobId/undo`).
 * Every call sits behind `org.manage` on the server; a refusal is the ordinary error line.
 * Not on the internal rail, like the receipt screen it leads to.
 */
export function ImportStartScreen({
  organizationSlug,
  organizationName,
  client,
}: ImportStartScreenProps) {
  const tOr = useTOr();
  const api = client ?? browserApiClient();

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={tOr('ImportStartScreen.title', 'Import your work')}
      titleVariant="display"
      eyebrow={tOr('ImportStartScreen.eyebrow', 'Onboarding · Import')}
      description={tOr(
        'ImportStartScreen.description',
        'Move projects and tasks from another tool. Nothing is saved until you start the import, and you can undo it for 7 days.',
      )}
    >
      <style href="tm-import-start" precedence="default">
        {IMPORT_START_CSS}
      </style>
      <ImportStart organizationSlug={organizationSlug} api={api} />
    </AppShell>
  );
}

function ImportStart({ organizationSlug, api }: { organizationSlug: string; api: ApiClient }) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [sourceId, setSourceId] = useState<ImportSourceId | null>(null);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [workspaceId, setWorkspaceId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [report, setReport] = useState<ImportValidationReport | null>(null);

  const preset = sourceId === null ? null : IMPORT_SOURCES[sourceId];

  const workspaces = useQuery({
    queryKey: ['workspaces', organizationSlug],
    queryFn: () => listWorkspaces(api, organizationSlug),
    enabled: preset?.kind === 'project',
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    enabled: preset !== null && preset.needsProject,
  });

  const missing = preset === null ? [] : missingRequired(preset, mapping);
  const targetChosen =
    preset === null ? false : preset.needsProject ? projectId !== '' : workspaceId !== '';
  const ready = preset !== null && file !== null && file.rows.length > 0 && missing.length === 0;

  const batch = useMemo<ImportBatchInput | null>(
    () =>
      preset === null || file === null ? null : buildBatch(preset, file.rows, mapping, workspaceId),
    [preset, file, mapping, workspaceId],
  );

  const check = useMutation({
    mutationFn: (input: ImportBatchInput) => validateImport(api, organizationSlug, input),
    onSuccess: setReport,
  });
  const start = useMutation({
    mutationFn: (input: ImportBatchInput & { jobId: string }) =>
      commitImport(api, organizationSlug, {
        ...input,
        ...(preset?.needsProject ? { projectId } : {}),
      }),
    onSuccess: async (receipt) => {
      await queryClient.invalidateQueries({ queryKey: ['imports', organizationSlug] });
      router.push(
        `/${encodeURIComponent(organizationSlug)}/onboarding/import/${encodeURIComponent(receipt.jobId)}`,
      );
    },
  });

  function reset(next: ImportSourceId) {
    setSourceId(next);
    setFile(null);
    setFileError(false);
    setMapping({});
    setReport(null);
    check.reset();
    start.reset();
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    setReport(null);
    setFileError(false);
    if (!picked || preset === null) {
      setFile(null);
      return;
    }
    try {
      if (preset.file === 'zip') {
        const rows = await readBasecampArchive(await picked.arrayBuffer());
        setFile({ name: picked.name, headers: [], rows, truncated: false });
        setMapping({});
      } else {
        const table = parseCsv(await picked.text());
        setFile({ name: picked.name, ...table });
        setMapping(autoMap(preset, table.headers));
      }
    } catch {
      setFile(null);
      setFileError(true);
    }
  }

  const fieldLabel = (target: string) =>
    tOr(`ImportStartScreen.field.${target}`, FIELD_LABELS[target] ?? target);

  return (
    <div className="tm-import-start">
      <ol
        className="tm-import-start__track"
        aria-label={tOr('ImportStartScreen.stepsLabel', 'Import steps')}
      >
        <li aria-current={preset === null ? 'step' : undefined}>
          <StateCapsule state={preset === null ? 'current' : 'done'}>
            {`1 · ${tOr('ImportStartScreen.stepSource', 'Choose source')}`}
          </StateCapsule>
        </li>
        <li aria-current={preset !== null && report === null ? 'step' : undefined}>
          <StateCapsule state={preset === null ? 'future' : report === null ? 'current' : 'done'}>
            {`2 · ${tOr('ImportStartScreen.stepUpload', 'Upload and map')}`}
          </StateCapsule>
        </li>
        <li aria-current={report !== null ? 'step' : undefined}>
          <StateCapsule state={report === null ? 'future' : 'current'}>
            {`3 · ${tOr('ImportStartScreen.stepCheck', 'Check and import')}`}
          </StateCapsule>
        </li>
      </ol>

      <section aria-labelledby="tm-import-sources">
        <h2 id="tm-import-sources" className="tm-import-start__eyebrow">
          {tOr('ImportStartScreen.chooseSource', 'Choose a source')}
        </h2>
        <div className="tm-import-start__sources">
          {IMPORT_SOURCE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className="tm-import-start__source"
              aria-pressed={sourceId === id}
              onClick={() => reset(id)}
            >
              <span className="tm-import-start__source-head">
                <span className="tm-import-start__source-name" dir="ltr">
                  {SOURCE_NAMES[id]}
                </span>
                <Badge tone="neutral">{IMPORT_SOURCES[id].file === 'zip' ? 'ZIP' : 'CSV'}</Badge>
              </span>
              <span className="tm-import-start__source-hint">
                {tOr(`ImportStartScreen.source.${id}`, SOURCE_HINTS[id])}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="tm-import-start__body">
        <section className="tm-import-start__card" aria-labelledby="tm-import-upload">
          <h2 id="tm-import-upload" className="tm-import-start__eyebrow">
            {tOr('ImportStartScreen.uploadTitle', 'Upload and map')}
          </h2>
          {preset === null || sourceId === null ? (
            <p className="tm-import-start__lead">
              {tOr('ImportStartScreen.emptyPick', 'Choose a source above to begin.')}
            </p>
          ) : (
            <>
              <div className="tm-import-start__pair">
                <Field
                  key={sourceId}
                  type="file"
                  accept={preset.file === 'zip' ? '.zip,application/zip' : '.csv,text/csv'}
                  label={tOr('ImportStartScreen.fileLabel', 'Export file')}
                  hint={
                    file === null
                      ? tOr(
                          `ImportStartScreen.fileHint.${sourceId}`,
                          preset.file === 'zip'
                            ? 'The ZIP archive Basecamp exports.'
                            : 'A CSV file, up to 1,000 rows.',
                        )
                      : `${file.rows.length} ${tOr('ImportStartScreen.rowsFound', 'rows found')}`
                  }
                  error={
                    fileError
                      ? tOr('ImportStartScreen.fileError', 'This file could not be read.')
                      : undefined
                  }
                  onChange={(event) => void onFile(event)}
                />
                {preset.needsProject ? (
                  <Select
                    label={tOr('ImportStartScreen.projectLabel', 'Target project')}
                    hint={tOr('ImportStartScreen.projectHint', 'New items land in this project.')}
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    <option value="">{tOr('ImportStartScreen.choose', 'Choose…')}</option>
                    {(projects.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Select
                    label={tOr('ImportStartScreen.workspaceLabel', 'Workspace')}
                    hint={tOr('ImportStartScreen.workspaceHint', 'New projects are created here.')}
                    value={workspaceId}
                    onChange={(event) => setWorkspaceId(event.target.value)}
                  >
                    <option value="">{tOr('ImportStartScreen.choose', 'Choose…')}</option>
                    {(workspaces.data ?? []).map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>

              {file !== null && file.truncated ? (
                <InlineAlert
                  tone="warning"
                  title={tOr('ImportStartScreen.truncatedTitle', 'Only the first 1,000 rows')}
                >
                  {tOr('ImportStartScreen.truncatedBody', 'Split the file to import the rest.')}
                </InlineAlert>
              ) : null}

              {file !== null && preset.fields.length > 0 ? (
                <fieldset className="tm-import-start__mapping">
                  <legend className="tm-import-start__subtitle">
                    {tOr('ImportStartScreen.matchColumns', 'Match columns')}
                  </legend>
                  {preset.fields.map((target) => (
                    <Select
                      key={target.target}
                      label={fieldLabel(target.target)}
                      value={mapping[target.target] ?? ''}
                      error={
                        target.required && !mapping[target.target]
                          ? tOr('ImportStartScreen.required', 'Choose a column for this field.')
                          : undefined
                      }
                      onChange={(event) => {
                        setReport(null);
                        setMapping((m) => ({ ...m, [target.target]: event.target.value }));
                      }}
                    >
                      <option value="">
                        {tOr('ImportStartScreen.notImported', 'Not imported')}
                      </option>
                      {file.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </Select>
                  ))}
                </fieldset>
              ) : null}

              {report !== null ? <ReportAlert report={report} fieldLabel={fieldLabel} /> : null}
              {check.isError ? (
                <InlineAlert
                  tone="danger"
                  title={tOr('ImportStartScreen.checkError', 'The file could not be checked')}
                  live
                >
                  {describe(check.error)}
                </InlineAlert>
              ) : null}
              {start.isError ? (
                <InlineAlert
                  tone="danger"
                  title={tOr('ImportStartScreen.startError', 'The import could not start')}
                  live
                >
                  {describe(start.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-import-start__actions">
                <Button
                  tone="outline"
                  disabled={!ready || !targetChosen || batch === null}
                  loading={check.isPending}
                  loadingLabel={tOr('ImportStartScreen.checking', 'Checking')}
                  onClick={() => batch !== null && check.mutate(batch)}
                >
                  {tOr('ImportStartScreen.check', 'Check file')}
                </Button>
                <Button
                  tone="lime"
                  disabled={
                    report === null ||
                    report.validCount === 0 ||
                    report.batchErrors.length > 0 ||
                    batch === null
                  }
                  loading={start.isPending}
                  loadingLabel={tOr('ImportStartScreen.starting', 'Importing')}
                  onClick={() =>
                    report !== null &&
                    batch !== null &&
                    start.mutate({ ...batch, jobId: report.jobId })
                  }
                >
                  {tOr('ImportStartScreen.start', 'Start import')}
                </Button>
              </div>
            </>
          )}
        </section>

        <RecentImports organizationSlug={organizationSlug} api={api} />
      </div>
    </div>
  );
}

function ReportAlert({
  report,
  fieldLabel,
}: {
  report: ImportValidationReport;
  fieldLabel: (target: string) => string;
}) {
  const tOr = useTOr();
  if (report.batchErrors.length > 0) {
    return (
      <InlineAlert
        tone="danger"
        title={tOr('ImportStartScreen.batchErrorTitle', 'This file cannot be imported')}
        live
      >
        {tOr(
          'ImportStartScreen.batchErrorBody',
          'A Jira file must hold one project, and a file at most 1,000 rows.',
        )}
      </InlineAlert>
    );
  }
  const problems = report.errors.slice(0, 5);
  return (
    <InlineAlert
      tone={report.invalidCount === 0 ? 'success' : 'warning'}
      title={`${report.validCount} ${tOr('ImportStartScreen.rowsReady', 'rows are ready')}`}
      live
    >
      {report.invalidCount === 0
        ? tOr('ImportStartScreen.allReady', 'Every row passed the check.')
        : `${report.invalidCount} ${tOr('ImportStartScreen.rowsSkipped', 'rows need a fix and will be skipped.')}`}
      {problems.length > 0 ? (
        <ul className="tm-import-start__problems">
          {problems.map((problem) => (
            <li key={problem.row}>
              {`${tOr('ImportStartScreen.row', 'Row')} ${problem.row + 1} · ${problem.errors
                .map((e) => fieldLabel(e.field))
                .join(', ')}`}
            </li>
          ))}
        </ul>
      ) : null}
    </InlineAlert>
  );
}

function RecentImports({ organizationSlug, api }: { organizationSlug: string; api: ApiClient }) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const format = useDisplayFormatters();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);

  const imports = useQuery({
    queryKey: ['imports', organizationSlug],
    queryFn: () => listImports(api, organizationSlug),
  });
  const undo = useMutation({
    mutationFn: (jobId: string) => undoImport(api, organizationSlug, jobId),
    onSuccess: async () => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: ['imports', organizationSlug] });
    },
  });

  return (
    <section className="tm-import-start__card" aria-labelledby="tm-import-recent">
      <h2 id="tm-import-recent" className="tm-import-start__eyebrow">
        {tOr('ImportStartScreen.recentTitle', 'Recent imports')}
      </h2>
      {imports.isPending ? (
        <LoadingRegion label={tOr('ImportStartScreen.loading', 'Loading recent imports')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}
      {imports.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('ImportStartScreen.loadError', 'Recent imports could not load')}
          live
        >
          {describe(imports.error)}
        </InlineAlert>
      ) : null}
      {undo.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('ImportStartScreen.undoError', 'The import could not be undone')}
          live
        >
          {describe(undo.error)}
        </InlineAlert>
      ) : null}
      {imports.isSuccess && imports.data.length === 0 ? (
        <div className="tm-import-start__empty">
          <p className="tm-import-start__subtitle">
            {tOr('ImportStartScreen.emptyRecent', 'No imports yet')}
          </p>
          <p className="tm-import-start__lead">
            {tOr(
              'ImportStartScreen.emptyRecentBody',
              'Your imports appear here with a receipt, and undo stays open for 7 days.',
            )}
          </p>
        </div>
      ) : null}
      {imports.isSuccess && imports.data.length > 0 ? (
        <>
          <div
            className="tm-table-scroll"
            role="region"
            aria-label={tOr('ImportStartScreen.recentTitle', 'Recent imports')}
          >
            <table className="tm-table">
              <thead>
                <tr>
                  <th scope="col">{tOr('ImportStartScreen.colSource', 'Source')}</th>
                  <th scope="col">{tOr('ImportStartScreen.colDate', 'Date')}</th>
                  <th scope="col">{tOr('ImportStartScreen.colResult', 'Result')}</th>
                  <th scope="col">{tOr('ImportStartScreen.colStatus', 'Status')}</th>
                  <th scope="col">
                    <span className="tm-visually-hidden">
                      {tOr('ImportStartScreen.colActions', 'Actions')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {imports.data.map((job) => (
                  <ImportRow
                    key={job.jobId}
                    job={job}
                    organizationSlug={organizationSlug}
                    date={format.day(job.committedAt ?? job.createdAt)}
                    confirming={confirming === job.jobId}
                    undoing={undo.isPending && undo.variables === job.jobId}
                    onAsk={() => setConfirming(job.jobId)}
                    onCancel={() => setConfirming(null)}
                    onUndo={() => undo.mutate(job.jobId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="tm-import-start__note">
            {tOr(
              'ImportStartScreen.undoNote',
              'Undo removes what an import created. It stays open for 7 days.',
            )}
          </p>
        </>
      ) : null}
    </section>
  );
}

function ImportRow({
  job,
  organizationSlug,
  date,
  confirming,
  undoing,
  onAsk,
  onCancel,
  onUndo,
}: {
  job: ImportJobSummary;
  organizationSlug: string;
  date: string;
  confirming: boolean;
  undoing: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onUndo: () => void;
}) {
  const tOr = useTOr();
  const total = job.committedCount + job.failedCount;
  const canUndo = job.undoneAt === null && job.undoAvailableUntil !== null;
  const status =
    job.undoneAt !== null ? (
      <StateCapsule state="archived">
        {tOr('ImportStartScreen.statusUndone', 'Undone')}
      </StateCapsule>
    ) : job.status === 'committed' ? (
      <StateCapsule state="done">
        {tOr('ImportStartScreen.statusImported', 'Imported')}
      </StateCapsule>
    ) : (
      <StateCapsule state="blocked">
        {tOr('ImportStartScreen.statusWithErrors', 'Imported with errors')}
      </StateCapsule>
    );

  return (
    <tr>
      <th scope="row">
        <span dir="ltr">{KIND_NAMES[job.sourceKind]}</span>
      </th>
      <td>{date}</td>
      <td>{`${job.committedCount} ${tOr('ImportStartScreen.of', 'of')} ${total} ${tOr('ImportStartScreen.created', 'created')}`}</td>
      <td>{status}</td>
      <td>
        <div className="tm-import-start__row-actions">
          {confirming ? (
            <>
              <Button
                tone="destructive"
                size="compact"
                loading={undoing}
                loadingLabel={tOr('ImportStartScreen.undoing', 'Undoing')}
                onClick={onUndo}
              >
                {tOr('ImportStartScreen.confirmUndo', 'Undo import')}
              </Button>
              <Button tone="text" size="compact" onClick={onCancel}>
                {tOr('ImportStartScreen.cancel', 'Cancel')}
              </Button>
            </>
          ) : (
            <>
              {canUndo ? (
                <Button tone="outline" size="compact" onClick={onAsk}>
                  {tOr('ImportStartScreen.undo', 'Undo')}
                </Button>
              ) : null}
              <Link
                className="tm-button tm-button--outline tm-button--compact"
                href={`/${encodeURIComponent(organizationSlug)}/onboarding/import/${encodeURIComponent(job.jobId)}`}
              >
                {tOr('ImportStartScreen.viewReceipt', 'View receipt')}
              </Link>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

const IMPORT_START_CSS = `
.tm-import-start { display: flex; flex-direction: column; gap: 28px; }
.tm-import-start__track { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tm-import-start__eyebrow {
  margin: 0 0 12px; font-family: var(--font-mono); font-size: 10px; line-height: 14px; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-500);
}
.tm-import-start__sources { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; }
.tm-import-start__source {
  display: flex; flex-direction: column; gap: 8px; min-inline-size: 0; padding: 22px; text-align: start;
  border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-card); background: var(--paper-0);
  color: var(--ink-950); font: inherit; cursor: pointer;
}
.tm-import-start__source:hover { border-color: var(--ink-500); }
.tm-import-start__source:focus-visible { outline: var(--b-structural) solid var(--ink-950); outline-offset: 2px; }
.tm-import-start__source[aria-pressed='true'] { border: var(--b-structural) solid var(--ink-950); padding: 21px; }
.tm-import-start__source-head { display: flex; align-items: center; gap: 10px; }
.tm-import-start__source-name { font-size: var(--t-body-md); line-height: 21px; font-weight: 600; }
.tm-import-start__source-hint { font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-650); }
.tm-import-start__body { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.tm-import-start__card {
  display: flex; flex-direction: column; gap: 18px; min-inline-size: 0; padding: 22px;
  border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-card); background: var(--paper-0);
}
.tm-import-start__card .tm-import-start__eyebrow { margin: 0; }
.tm-import-start__pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.tm-import-start__mapping { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px 16px; margin: 0; padding: 0; border: 0; }
.tm-import-start__subtitle { margin: 0; padding: 0; font-size: var(--t-body-md); line-height: 21px; font-weight: 600; color: var(--ink-950); }
.tm-import-start__mapping > legend { grid-column: 1 / -1; margin-block-end: 10px; }
.tm-import-start__lead { margin: 0; font-size: var(--t-ui-sm); line-height: 19px; color: var(--ink-650); }
.tm-import-start__note { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-500); }
.tm-import-start__problems { margin: 8px 0 0; padding-inline-start: 18px; }
.tm-import-start__actions { display: flex; flex-wrap: wrap; gap: 12px; }
.tm-import-start__row-actions { display: flex; justify-content: flex-end; gap: 8px; white-space: nowrap; }
.tm-import-start__empty { display: flex; flex-direction: column; gap: 6px; }
.tm-import-start .tm-table-scroll { border: 0; }
@media (max-width: 80rem) { .tm-import-start__sources { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 60rem) {
  .tm-import-start__body, .tm-import-start__pair, .tm-import-start__mapping { grid-template-columns: minmax(0, 1fr); }
  .tm-import-start__sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
