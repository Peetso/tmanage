'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { DocsSidebar } from '../docs/DocsSidebar';
import { DocTitleEditor, type RenameStatus } from '../docs/DocTitleEditor';
import { DocShareDialog } from '../docs/DocShareDialog';
import { caretPoint } from '../docs/doc-caret';
import '../docs/docs-shell.css';
import {
  DOC_TOOL_EDITS,
  applyDocEdit,
  diffLines,
  filterSlashCommands,
  isBlankBody,
  rtlLine,
  slashTriggerAt,
  tagFor,
  type DocToolId,
  type SlashCommand,
} from '../docs/doc-markdown';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getDocument,
  getDocumentSharing,
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
  saveDocumentVersion,
  setDocumentAudience,
} from '../../lib/api/documents';
import { listProjects } from '../../lib/api/projects';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocumentEditorScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The document being edited — its id arrives in the route path. */
  documentId: string;
  client?: ApiClient;
  /** How long typing must pause before the draft is saved. Tests pass a short one. */
  autosaveDelayMs?: number;
}

/** The toolbar of 383:3806, in its order. `words` marks a label drawn in the UI font in Arabic. */
const TOOLS: readonly {
  readonly id: DocToolId;
  readonly key: string;
  readonly english: string;
  readonly glyph?: string;
  readonly words?: boolean;
}[] = [
  { id: 'h1', key: 'DocumentEditorScreen.toolH1', english: 'H1' },
  { id: 'h2', key: 'DocumentEditorScreen.toolH2', english: 'H2' },
  { id: 'bold', key: 'DocumentEditorScreen.toolBold', english: 'B' },
  { id: 'italic', key: 'DocumentEditorScreen.toolItalic', english: 'I' },
  { id: 'list', key: 'DocumentEditorScreen.toolList', english: 'List', glyph: '•', words: true },
  {
    id: 'checklist',
    key: 'DocumentEditorScreen.toolChecklist',
    english: 'Checklist',
    glyph: '☐',
    words: true,
  },
  { id: 'link', key: 'DocumentEditorScreen.toolLink', english: 'Link', glyph: '↗', words: true },
];

/**
 * **DOC-02 editor** — the blank new doc of Figma 383:3806 / 383:4019 (A15).
 *
 * The Slack-like docs column on the start side; a top bar with the breadcrumb ("Docs / <project>"),
 * the save state ("Saved · just now"), Share (copies the document's link) and Publish (the client
 * audience, offered only when the API says the caller may publish); the toolbar (markdown edits on
 * the body at the selection); then the sheet: the title, the Draft pill with who can see it, the
 * body with its placeholder and — while the body is empty — "Or start from a template".
 *
 * **Every pause is a save.** Typing stops for {@link DocumentEditorScreenProps.autosaveDelayMs} and
 * the body is saved as a new immutable version (the API appends a snapshot); restore stays
 * forward-append. Once a document has more than one version, its history sits folded under the
 * sheet, so the blank document reads exactly as designed.
 */
export function DocumentEditorScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
  autosaveDelayMs = 1200,
}: DocumentEditorScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });
  const versions = useQuery({
    queryKey: ['document-versions', organizationSlug, documentId],
    queryFn: () => listDocumentVersions(api, organizationSlug, documentId),
  });
  const sharing = useQuery({
    queryKey: ['document-sharing', organizationSlug, documentId],
    queryFn: () => getDocumentSharing(api, organizationSlug, documentId),
  });
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // `null` = not edited yet: the body shows the document's current text (blank shows as empty).
  const [draft, setDraft] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [shareOpen, setShareOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // The selection to put back on the body after a toolbar or "/" edit has rendered.
  const [pendingSelection, setPendingSelection] = useState<{
    readonly start: number;
    readonly end: number;
  } | null>(null);
  // The "/" menu (Figma 446:35321): where the slash is, what follows it, which row is active.
  const [slash, setSlash] = useState<{
    readonly at: number;
    readonly query: string;
    readonly active: number;
    readonly top: number;
    readonly left: number;
  } | null>(null);
  // F2: the title rename's own save state, shown in the same place as the body's.
  const [renameStatus, setRenameStatus] = useState<RenameStatus>('idle');
  // Keep the newest `now` when the document (re)loads, so a fresh document reads "just now".
  const loadedAt = document.dataUpdatedAt;
  useEffect(() => {
    if (loadedAt > 0) setNow(Date.now());
  }, [loadedAt]);

  const data = document.data;
  const stored = data && !isBlankBody(data.body) ? data.body : '';
  const body = draft ?? stored;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['document', organizationSlug, documentId] }),
      queryClient.invalidateQueries({
        queryKey: ['document-versions', organizationSlug, documentId],
      }),
    ]);
  };

  const save = useMutation({
    mutationFn: (text: string) => saveDocumentVersion(api, organizationSlug, documentId, text),
    onSuccess: async () => {
      setSavedAt(Date.now());
      setNow(Date.now());
      await invalidate();
    },
  });

  const restore = useMutation({
    mutationFn: (versionNo: number) =>
      restoreDocumentVersion(api, organizationSlug, documentId, versionNo),
    onSuccess: async () => {
      setDraft(null);
      setSelectedVersion(null);
      setSavedAt(Date.now());
      await invalidate();
    },
  });

  const publish = useMutation({
    mutationFn: () => setDocumentAudience(api, organizationSlug, documentId, 'client'),
    onSuccess: (next) => {
      queryClient.setQueryData(['document-sharing', organizationSlug, documentId], next);
    },
  });

  const comparison = useQuery({
    queryKey: ['document-version', organizationSlug, documentId, selectedVersion],
    queryFn: () => getDocumentVersion(api, organizationSlug, documentId, selectedVersion as number),
    enabled: selectedVersion !== null,
  });

  // Autosave: a pause in typing saves the draft once, if it differs from what is stored.
  const { mutate: saveNow } = save;
  useEffect(() => {
    if (draft === null || draft.trim() === '' || draft === stored) return undefined;
    const timer = setTimeout(() => saveNow(draft), autosaveDelayMs);
    return () => clearTimeout(timer);
  }, [draft, stored, autosaveDelayMs, saveNow]);

  // "Saved · just now" ages into a clock time after a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const projectName =
    (Array.isArray(projects.data) ? projects.data : []).find(
      (project) => project.id === data?.projectId,
    )?.name ?? '';
  const published = sharing.data?.audience === 'client';
  const rows = versions.data ?? [];
  // Newest first; the newest is "Current" and is what every other version is compared with.
  const ordered = [...rows].sort((a, b) => b.versionNo - a.versionNo);
  const currentNo = ordered[0]?.versionNo ?? null;
  const people = sharing.data?.collaborators ?? [];
  const authorOf = (userId: string) =>
    people.find((person) => person.userId === userId)?.displayName ?? '';
  const pickedRow = rows.find((version) => version.versionNo === selectedVersion);
  const compared =
    selectedVersion !== null && selectedVersion !== currentNo
      ? (comparison.data ?? pickedRow ?? null)
      : null;
  const changes = compared ? diffLines(compared.body, body) : [];
  const changeCount = changes.reduce((sum, block) => sum + block.lines.length, 0);

  /**
   * Apply a toolbar edit to `text` at `[start, end)`. Live test 2026-10-31: words typed right after a
   * toolbar click were lost (focus stayed on the button, so Space pressed it again) and Bold left the
   * "text" placeholder unselected. The buttons no longer take focus (mousedown is cancelled), the
   * caret and selection go back in a layout effect right after the new text renders, and an inserted
   * placeholder is selected so the next word replaces it.
   */
  function applyTool(id: DocToolId, text = body, start?: number, end?: number) {
    const control = bodyRef.current;
    const from = start ?? control?.selectionStart ?? text.length;
    const to = end ?? control?.selectionEnd ?? text.length;
    const result = applyDocEdit(
      text,
      from,
      to,
      DOC_TOOL_EDITS[id],
      tOr('DocumentEditorScreen.toolPlaceholder', 'text'),
    );
    setDraft(result.text);
    setPendingSelection({ start: result.selectionStart, end: result.caret });
  }

  useLayoutEffect(() => {
    if (!pendingSelection) return;
    const control = bodyRef.current;
    control?.focus();
    control?.setSelectionRange(pendingSelection.start, pendingSelection.end);
    setPendingSelection(null);
  }, [pendingSelection]);

  const slashLabel = (command: SlashCommand) => tOr(command.key, command.english);
  const slashMatches = slash ? filterSlashCommands(slash.query, slashLabel) : [];

  function onBodyChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const text = event.target.value;
    const caret = event.target.selectionStart ?? text.length;
    setDraft(text);
    const opened = slashTriggerAt(text, caret);
    if (opened >= 0) {
      const point = caretPoint(event.target, opened);
      const control = event.target;
      setSlash({
        at: opened,
        query: '',
        active: 0,
        top: (point ? point.top + point.lineHeight : 24) + control.offsetTop + 4,
        left: (point ? point.left : 0) + control.offsetLeft,
      });
      return;
    }
    if (!slash) return;
    // Still typing the filter right after the slash: "/head".
    if (text[slash.at] !== '/' || caret <= slash.at) {
      setSlash(null);
      return;
    }
    const query = text.slice(slash.at + 1, caret);
    if (/\s/u.test(query) || query.length > 20) {
      setSlash(null);
      return;
    }
    setSlash({ ...slash, query, active: 0 });
  }

  function chooseSlash(command: SlashCommand) {
    if (!slash) return;
    const control = bodyRef.current;
    const caret = control?.selectionStart ?? slash.at + 1 + slash.query.length;
    // Take out "/query", then apply the command where the slash was.
    const text = body.slice(0, slash.at) + body.slice(Math.max(caret, slash.at + 1));
    setSlash(null);
    applyTool(command.id, text, slash.at, slash.at);
  }

  function onBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!slash) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setSlash(null);
      return;
    }
    if (slashMatches.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSlash({
        ...slash,
        active: (slash.active + step + slashMatches.length) % slashMatches.length,
      });
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const command = slashMatches[Math.min(slash.active, slashMatches.length - 1)];
      if (command) chooseSlash(command);
    }
  }

  const savedInstant = savedAt ?? (data ? Date.parse(data.updatedAt) : Number.NaN);
  const renaming = renameStatus === 'saving';
  const savedLabel =
    save.isPending || renaming
      ? tOr('DocumentEditorScreen.saving', 'Saving…')
      : renameStatus === 'conflict'
        ? tOr('DocumentEditorScreen.notSaved', 'Not saved')
        : Number.isNaN(savedInstant)
          ? ''
          : now - savedInstant < 60_000
            ? tOr('DocumentEditorScreen.savedJustNow', 'Saved · just now')
            : `${tOr('DocumentEditorScreen.savedAt', 'Saved ·')} ${formatClock(
                new Date(savedInstant).toISOString(),
                locale,
              )}`;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title={data ? data.title : tOr('DocumentEditorScreen.editFallback', 'Document')}
      contextRail={
        <DocsSidebar
          api={api}
          organizationSlug={organizationSlug}
          activeDocumentId={documentId}
          {...(data ? { projectId: data.projectId } : {})}
        />
      }
    >
      <div className="tm-docpage">
        <div className="tm-docpage__bar">
          <nav aria-label={tOr('DocumentEditorScreen.breadcrumbAria', 'Breadcrumb')}>
            <ol className="tm-docpage__crumbs">
              <li>
                <Link href={`/${organizationSlug}/docs`}>
                  {tOr('DocumentEditorScreen.crumbDocs', 'Docs')}
                </Link>
              </li>
              {projectName !== '' ? (
                <>
                  <li aria-hidden="true">/</li>
                  <li>{projectName}</li>
                </>
              ) : null}
            </ol>
          </nav>
          <div className="tm-docpage__bar-end">
            <span className="tm-docpage__saved tm-doctitle__saving" role="status">
              {renaming ? <span className="tm-doctitle__spinner" aria-hidden="true" /> : null}
              {savedLabel}
            </span>
            {/* Live test 2026-10-31: Share only copied the link, with no word on who can see the
                doc. It opens the share dialog (Figma 446:35464), which also copies the link. */}
            <button
              type="button"
              className="tm-docpage__btn"
              aria-haspopup="dialog"
              onClick={() => setShareOpen(true)}
            >
              {tOr('DocumentEditorScreen.share', 'Share')}
            </button>
            {sharing.data?.canPublish && !published ? (
              <button
                type="button"
                className="tm-docpage__btn"
                data-tone="ink"
                disabled={publish.isPending}
                onClick={() => publish.mutate()}
              >
                {tOr('DocumentEditorScreen.publish', 'Publish')}
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="tm-docpage__tools"
          role="toolbar"
          aria-label={tOr('DocumentEditorScreen.toolbarAria', 'Formatting')}
        >
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="tm-docpage__tool"
              data-words={tool.words ? 'true' : 'false'}
              // Keep the focus (and the selection) in the body: the click edits it in place.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => applyTool(tool.id)}
            >
              {tool.glyph ? <span aria-hidden="true">{tool.glyph}</span> : null}
              {tOr(tool.key, tool.english)}
            </button>
          ))}
        </div>

        {document.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('DocumentEditorScreen.loadError', 'Could not load this document')}
            live
          >
            {describeError(document.error)}
          </InlineAlert>
        ) : null}
        {document.isPending ? (
          <LoadingRegion label={tOr('DocumentEditorScreen.loading', 'Loading the document')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {data ? (
          <section className="tm-docpage__sheet" aria-labelledby="tm-doc-title">
            <DocTitleEditor
              api={api}
              organizationSlug={organizationSlug}
              document={data}
              onStatus={(status) => {
                setRenameStatus(status);
                if (status === 'saved') {
                  setSavedAt(Date.now());
                  setNow(Date.now());
                }
              }}
            />
            <p className="tm-docpage__meta">
              <span className="tm-docpage__pill">
                {published
                  ? tOr('DocumentEditorScreen.published', 'Published')
                  : tOr('DocumentEditorScreen.draft', 'Draft')}
              </span>
              <span>
                {rtlLine(
                  `${projectName !== '' ? `${projectName} · ` : ''}${
                    published
                      ? tOr(
                          'DocumentEditorScreen.publishedNote',
                          "The project's client people can read this document",
                        )
                      : // Live test 2026-10-31: "Only you can see this draft" was not true — the
                        // project's team can open it. Figma 446:35321 / 446:35464 say who can.
                        tOr(
                          'DocumentEditorScreen.draftNoteTeam',
                          'Your team can see this draft · clients only after you publish',
                        )
                  }`,
                  locale,
                )}
              </span>
            </p>
            <label className="tm-visually-hidden" htmlFor="tm-doc-body">
              {tOr('DocumentEditorScreen.documentBody', 'Document body')}
            </label>
            <div className="tm-docpage__bodywrap">
              <textarea
                id="tm-doc-body"
                ref={bodyRef}
                name="body"
                className="tm-docpage__body"
                value={body}
                placeholder={tOr(
                  'DocumentEditorScreen.placeholder',
                  'Start writing, or type / for headings, lists and checklists.',
                )}
                role={slash ? 'combobox' : undefined}
                aria-expanded={slash ? true : undefined}
                aria-controls={slash ? 'tm-doc-slash' : undefined}
                aria-autocomplete={slash ? 'list' : undefined}
                aria-activedescendant={
                  slash && slashMatches.length > 0
                    ? `tm-doc-slash-${Math.min(slash.active, slashMatches.length - 1)}`
                    : undefined
                }
                onChange={onBodyChange}
                onKeyDown={onBodyKeyDown}
                onBlur={() => setSlash(null)}
                onClick={() => setSlash(null)}
              />
              {slash ? (
                <div
                  className="tm-docpage__slash"
                  style={{ top: slash.top, left: slash.left }}
                  data-empty={slashMatches.length === 0 ? 'true' : 'false'}
                >
                  {slashMatches.length > 0 ? (
                    <ul
                      id="tm-doc-slash"
                      role="listbox"
                      aria-label={tOr('DocumentEditorScreen.slashAria', 'Insert a block')}
                    >
                      {slashMatches.map((command, index) => (
                        <li
                          key={command.id}
                          id={`tm-doc-slash-${index}`}
                          role="option"
                          aria-selected={index === slash.active}
                          className="tm-docpage__slash-item"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            chooseSlash(command);
                          }}
                          onMouseEnter={() => setSlash({ ...slash, active: index })}
                        >
                          <span className="tm-docpage__slash-glyph" aria-hidden="true">
                            {command.glyph}
                          </span>
                          {slashLabel(command)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="tm-docpage__slash-none">
                      {tOr('DocumentEditorScreen.slashNone', 'No matching blocks')}
                    </p>
                  )}
                  <p className="tm-docpage__slash-hint" aria-hidden="true">
                    {rtlLine(
                      tOr(
                        'DocumentEditorScreen.slashHint',
                        '↑ ↓ to move · Enter to insert · Esc to close',
                      ),
                      locale,
                    )}
                  </p>
                </div>
              ) : null}
            </div>
            {body.trim() === '' ? (
              <Link className="tm-docpage__template" href={`/${organizationSlug}/docs/templates`}>
                {tOr('DocumentEditorScreen.fromTemplate', 'Or start from a template')}
              </Link>
            ) : null}

            {save.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('DocumentEditorScreen.saveError', 'Could not save')}
                live
              >
                {describeError(save.error)}
              </InlineAlert>
            ) : null}
            {publish.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('DocumentEditorScreen.publishError', 'Could not publish')}
                live
              >
                {describeError(publish.error)}
              </InlineAlert>
            ) : null}

            {rows.length > 1 ? (
              <details className="tm-docpage__history">
                <summary>
                  {tOr('DocumentEditorScreen.versionHistory', 'Version history')} · {rows.length}
                </summary>
                {/* DOC-03 Document history (Figma 145:224): the versions as cards, then Compare —
                    "13 Aug 17:32 → Current", the added and removed lines, and Restore with its
                    note. Live test 2026-10-31: Compare showed the old text with no diff or label,
                    and Restore sat on every row with no look first. */}
                <div className="tm-docpage__versions">
                  <ol aria-label={tOr('DocumentEditorScreen.savedVersionsAria', 'Saved versions')}>
                    {ordered.map((version) => {
                      const isCurrent = version.versionNo === currentNo;
                      const who = authorOf(version.editedByUserId);
                      return (
                        <li key={version.id}>
                          <button
                            type="button"
                            className="tm-docpage__version"
                            aria-pressed={
                              isCurrent ? undefined : selectedVersion === version.versionNo
                            }
                            aria-current={isCurrent ? 'true' : undefined}
                            disabled={isCurrent}
                            onClick={() => setSelectedVersion(version.versionNo)}
                          >
                            <span className="tm-docpage__version-when">
                              {isCurrent
                                ? `${tOr('DocumentEditorScreen.current', 'Current')} · ${formatClock(version.createdAt, locale)}`
                                : formatClock(version.createdAt, locale)}
                            </span>
                            <span className="tm-docpage__version-who">
                              {who !== ''
                                ? who
                                : `${tOr('DocumentEditorScreen.versionPrefix', 'v')}${version.versionNo}`}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                  {compared ? (
                    <section
                      className="tm-docpage__compare"
                      aria-label={tOr('DocumentEditorScreen.compareAria', 'Compare versions')}
                    >
                      <p className="tm-docpage__compare-head">
                        <span>
                          {tOr('DocumentEditorScreen.compare', 'Compare')} ·{' '}
                          {formatClock(compared.createdAt, locale)} →{' '}
                          {tOr('DocumentEditorScreen.current', 'Current')}
                        </span>
                        <span>
                          {changeCount === 1
                            ? tOr('DocumentEditorScreen.oneChange', '1 change')
                            : tOr('DocumentEditorScreen.changes', '{count} changes').replace(
                                '{count}',
                                String(changeCount),
                              )}
                        </span>
                      </p>
                      {changes.length === 0 ? (
                        <p className="tm-docpage__compare-same">
                          {tOr(
                            'DocumentEditorScreen.noChanges',
                            'This version reads the same as the current one.',
                          )}
                        </p>
                      ) : (
                        changes.map((block, index) => (
                          <div key={index} className="tm-docpage__change" data-kind={block.kind}>
                            <p className="tm-docpage__change-kind">
                              {block.kind === 'added'
                                ? tOr('DocumentEditorScreen.added', 'Added')
                                : tOr('DocumentEditorScreen.removed', 'Removed')}
                            </p>
                            {block.lines.map((line, at) =>
                              block.kind === 'removed' ? (
                                <del key={at}>{line}</del>
                              ) : (
                                <ins key={at}>{line}</ins>
                              ),
                            )}
                          </div>
                        ))
                      )}
                      <div className="tm-docpage__restore">
                        <button
                          type="button"
                          className="tm-docpage__btn"
                          disabled={restore.isPending}
                          onClick={() => restore.mutate(compared.versionNo)}
                        >
                          {tOr(
                            'DocumentEditorScreen.restoreVersion',
                            'Restore {when} version',
                          ).replace('{when}', formatClock(compared.createdAt, locale))}
                        </button>
                        <p>
                          {tOr(
                            'DocumentEditorScreen.restoreNote',
                            'Restoring creates a new version. Nothing is overwritten.',
                          )}
                        </p>
                      </div>
                    </section>
                  ) : null}
                </div>
              </details>
            ) : null}
          </section>
        ) : null}
        {shareOpen && data ? (
          <DocShareDialog
            organizationSlug={organizationSlug}
            documentId={documentId}
            documentTitle={data.title}
            projectName={projectName}
            sharing={sharing.data}
            onClose={() => setShareOpen(false)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}

/** "10:51" today, else "16 Oct, 10:51" — Latin digits in Arabic. */
function formatClock(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const tag = tagFor(locale);
  const sameDay = new Date().toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(tag, {
    ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}
