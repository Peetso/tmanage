/**
 * R45 L3 (54-25) — the Trello and Asana REST sources, read with the owner's own personal token.
 *
 * No app registration: Trello takes the owner's API key + token (sent in an `Authorization: OAuth`
 * header, never in a URL), Asana a personal access token (`Bearer`). Every call goes through
 * `pmGetJson` (`pm-egress.ts`): only `api.trello.com` / `app.asana.com`, no redirects, bounded
 * bodies, timeouts. Ids that reach a URL path are checked against the provider's id shape first.
 *
 * Both sources are read into one normalised shape ({@link PmBoardData}); `pm-import-plan.ts`
 * decides what becomes of it. The provenance URL of every card is built here from checked ids,
 * never copied from the provider's response.
 */

import { PmFetchError, list, pmGetJson, rec, str } from './pm-egress.js';
import type { PmFetch } from './pm-egress.js';

export const PM_SOURCES = ['trello', 'asana'] as const;
export type PmSource = (typeof PM_SOURCES)[number];

export function isPmSource(value: unknown): value is PmSource {
  return value === 'trello' || value === 'asana';
}

/** Cards / tasks read per import (the import batch bound). */
export const MAX_PM_CARDS = 1000;
/** Boards / projects one import may read. */
export const MAX_PM_BOARDS = 10;
/** Comments kept per card. */
export const MAX_PM_COMMENTS_PER_CARD = 100;
const MAX_ASANA_WORKSPACES = 5;
const ASANA_PAGE = 100;

const TRELLO_ID = /^[0-9a-f]{24}$/u;
const TRELLO_SHORT = /^[A-Za-z0-9]{1,24}$/u;
const ASANA_GID = /^\d{1,30}$/u;
const TRELLO_KEY = /^[0-9a-fA-F]{32}$/u;
const TRELLO_TOKEN = /^[A-Za-z0-9_-]{20,256}$/u;
const ASANA_PAT = /^[A-Za-z0-9/:._-]{16,256}$/u;

export interface PmCredential {
  readonly source: PmSource;
  /** Trello only. */
  readonly apiKey?: string;
  readonly token: string;
}

/** The credential the owner pasted, shape-checked; `null` when it cannot be one. */
export function parsePmCredential(
  source: PmSource,
  body: { readonly apiKey?: unknown; readonly token?: unknown },
): PmCredential | null {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (source === 'trello') {
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!TRELLO_KEY.test(apiKey) || !TRELLO_TOKEN.test(token)) return null;
    return { source, apiKey, token };
  }
  return ASANA_PAT.test(token) ? { source, token } : null;
}

export function isPmBoardId(source: PmSource, id: unknown): id is string {
  return typeof id === 'string' && (source === 'trello' ? TRELLO_ID : ASANA_GID).test(id);
}

export interface PmBoard {
  readonly id: string;
  readonly name: string;
  /** The Asana workspace name; `null` for Trello. */
  readonly group: string | null;
}

export interface PmPerson {
  /** The e-mail (lower case) when the source shares it, else `trello:<username>` / `asana:<gid>`. */
  readonly key: string;
  readonly name: string;
  readonly email: string | null;
}

export interface PmComment {
  readonly authorName: string;
  readonly text: string;
  /** ISO-8601, or `null`. */
  readonly createdAt: string | null;
}

export interface PmCard {
  readonly externalId: string;
  /** The card's address at the source — the idempotency marker. */
  readonly url: string;
  readonly boardId: string;
  readonly title: string;
  readonly description: string | null;
  /** The Trello list / Asana section name. */
  readonly container: string | null;
  /** `YYYY-MM-DD`. */
  readonly dueOn: string | null;
  readonly assigneeKeys: readonly string[];
  readonly completed: boolean;
  /** Trello archived card; skipped by the plan. */
  readonly archived: boolean;
  /** `null` when comments were not read (Asana preview). */
  readonly comments: readonly PmComment[] | null;
}

export interface PmBoardData {
  readonly containers: readonly string[];
  readonly people: readonly PmPerson[];
  readonly cards: readonly PmCard[];
  /** More than {@link MAX_PM_CARDS} cards existed; the rest were not read. */
  readonly truncated: boolean;
}

function authHeaders(credential: PmCredential): Record<string, string> {
  return credential.source === 'trello'
    ? {
        Authorization: `OAuth oauth_consumer_key="${credential.apiKey ?? ''}", oauth_token="${credential.token}"`,
      }
    : { Authorization: `Bearer ${credential.token}` };
}

function dateOnly(value: unknown): string | null {
  const s = str(value);
  if (s === null) return null;
  const day = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : null;
}

function email(value: unknown): string | null {
  const s = str(value);
  return s !== null && s.length <= 254 && /^[^\s@]+@[^\s@]+$/u.test(s) ? s.toLowerCase() : null;
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ─── Trello ──────────────────────────────────────────────────────────────

const TRELLO = 'https://api.trello.com/1';

async function trelloBoards(fetcher: PmFetch, credential: PmCredential): Promise<PmBoard[]> {
  const body = await pmGetJson(
    fetcher,
    `${TRELLO}/members/me/boards?filter=open&fields=id,name`,
    authHeaders(credential),
  );
  return list(body).flatMap((raw) => {
    const board = rec(raw);
    const id = str(board?.['id']);
    if (id === null || !TRELLO_ID.test(id)) return [];
    return [{ id, name: cut(str(board?.['name']) ?? id, 200), group: null }];
  });
}

async function trelloBoard(
  fetcher: PmFetch,
  credential: PmCredential,
  boardId: string,
  withComments: boolean,
  room: number,
): Promise<PmBoardData> {
  const headers = authHeaders(credential);
  const base = `${TRELLO}/boards/${boardId}`;
  const lists = list(await pmGetJson(fetcher, `${base}/lists?filter=all&fields=id,name`, headers));
  const listName = new Map<string, string>();
  for (const raw of lists) {
    const l = rec(raw);
    const id = str(l?.['id']);
    if (id !== null) listName.set(id, cut(str(l?.['name']) ?? id, 120));
  }
  const members = list(
    await pmGetJson(fetcher, `${base}/members?fields=id,fullName,username`, headers),
  );
  const personById = new Map<string, PmPerson>();
  for (const raw of members) {
    const m = rec(raw);
    const id = str(m?.['id']);
    const username = str(m?.['username']);
    if (id === null || username === null) continue;
    personById.set(id, {
      key: `trello:${username.toLowerCase()}`,
      name: cut(str(m?.['fullName']) ?? username, 200),
      email: null,
    });
  }
  const rawCards = list(
    await pmGetJson(
      fetcher,
      `${base}/cards?filter=all&fields=id,name,desc,due,idList,idMembers,shortLink,closed,dueComplete`,
      headers,
    ),
  );
  const comments = new Map<string, PmComment[]>();
  if (withComments) {
    const actions = list(
      await pmGetJson(
        fetcher,
        `${base}/actions?filter=commentCard&limit=1000&fields=data,date&memberCreator_fields=fullName,username`,
        headers,
      ),
    );
    for (const raw of actions) {
      const action = rec(raw);
      const data = rec(action?.['data']);
      const cardId = str(rec(data?.['card'])?.['id']);
      const text = str(data?.['text']);
      if (cardId === null || text === null) continue;
      const creator = rec(action?.['memberCreator']);
      const bucket = comments.get(cardId) ?? [];
      bucket.push({
        authorName: cut(str(creator?.['fullName']) ?? str(creator?.['username']) ?? '', 200),
        text,
        createdAt: str(action?.['date']),
      });
      comments.set(cardId, bucket);
    }
  }
  const cards: PmCard[] = [];
  for (const raw of rawCards) {
    if (cards.length >= room) break;
    const card = rec(raw);
    const id = str(card?.['id']);
    const short = str(card?.['shortLink']);
    if (id === null || !TRELLO_ID.test(id) || short === null || !TRELLO_SHORT.test(short)) continue;
    const idMembers = list(card?.['idMembers']).filter((m): m is string => typeof m === 'string');
    const listId = str(card?.['idList']);
    cards.push({
      externalId: id,
      url: `https://trello.com/c/${short}`,
      boardId,
      title: cut(str(card?.['name']) ?? '(untitled)', 300),
      description: str(card?.['desc']),
      container: listId === null ? null : (listName.get(listId) ?? null),
      dueOn: dateOnly(card?.['due']),
      assigneeKeys: idMembers.flatMap((m) => {
        const person = personById.get(m);
        return person === undefined ? [] : [person.key];
      }),
      completed: card?.['dueComplete'] === true,
      archived: card?.['closed'] === true,
      comments: withComments
        ? (comments.get(id) ?? []).slice(0, MAX_PM_COMMENTS_PER_CARD).reverse()
        : null,
    });
  }
  return {
    containers: [...new Set(listName.values())],
    people: [...personById.values()],
    cards,
    truncated: rawCards.length > cards.length,
  };
}

// ─── Asana ───────────────────────────────────────────────────────────────

const ASANA = 'https://app.asana.com/api/1.0';

async function asanaBoards(fetcher: PmFetch, credential: PmCredential): Promise<PmBoard[]> {
  const headers = authHeaders(credential);
  const workspaces = list(
    rec(await pmGetJson(fetcher, `${ASANA}/workspaces?limit=100&opt_fields=name`, headers))?.[
      'data'
    ],
  ).slice(0, MAX_ASANA_WORKSPACES);
  const boards: PmBoard[] = [];
  for (const raw of workspaces) {
    const ws = rec(raw);
    const wsGid = str(ws?.['gid']);
    if (wsGid === null || !ASANA_GID.test(wsGid)) continue;
    const projects = list(
      rec(
        await pmGetJson(
          fetcher,
          `${ASANA}/projects?workspace=${wsGid}&archived=false&limit=100&opt_fields=name`,
          headers,
        ),
      )?.['data'],
    );
    for (const p of projects) {
      const project = rec(p);
      const gid = str(project?.['gid']);
      if (gid === null || !ASANA_GID.test(gid)) continue;
      boards.push({
        id: gid,
        name: cut(str(project?.['name']) ?? gid, 200),
        group: cut(str(ws?.['name']) ?? '', 200),
      });
    }
  }
  return boards;
}

async function asanaBoard(
  fetcher: PmFetch,
  credential: PmCredential,
  projectGid: string,
  withComments: boolean,
  room: number,
): Promise<PmBoardData> {
  const headers = authHeaders(credential);
  const sections = list(
    rec(
      await pmGetJson(fetcher, `${ASANA}/projects/${projectGid}/sections?opt_fields=name`, headers),
    )?.['data'],
  ).flatMap((raw) => {
    const name = str(rec(raw)?.['name']);
    return name === null ? [] : [cut(name, 120)];
  });
  const people = new Map<string, PmPerson>();
  const cards: PmCard[] = [];
  let offset: string | null = null;
  let truncated = false;
  const fields =
    'name,notes,due_on,completed,assignee.name,assignee.email,memberships.section.name,memberships.project.gid';
  for (let page = 0; page < 50; page += 1) {
    const url = `${ASANA}/tasks?project=${projectGid}&limit=${ASANA_PAGE}&opt_fields=${fields}${
      offset === null ? '' : `&offset=${encodeURIComponent(offset)}`
    }`;
    const body = rec(await pmGetJson(fetcher, url, headers));
    for (const raw of list(body?.['data'])) {
      if (cards.length >= room) {
        truncated = true;
        break;
      }
      const task = rec(raw);
      const gid = str(task?.['gid']);
      if (gid === null || !ASANA_GID.test(gid)) continue;
      const assignee = rec(task?.['assignee']);
      const keys: string[] = [];
      if (assignee !== null) {
        const mail = email(assignee['email']);
        const aGid = str(assignee['gid']);
        const key = mail ?? (aGid !== null && ASANA_GID.test(aGid) ? `asana:${aGid}` : null);
        if (key !== null) {
          keys.push(key);
          people.set(key, { key, name: cut(str(assignee['name']) ?? key, 200), email: mail });
        }
      }
      const membership = list(task?.['memberships'])
        .map(rec)
        .find((m) => str(rec(m?.['project'])?.['gid']) === projectGid);
      cards.push({
        externalId: gid,
        url: `https://app.asana.com/0/${projectGid}/${gid}`,
        boardId: projectGid,
        title: cut(str(task?.['name']) ?? '(untitled)', 300),
        description: str(task?.['notes']),
        container: str(rec(membership?.['section'])?.['name']),
        dueOn: dateOnly(task?.['due_on']),
        assigneeKeys: keys,
        completed: task?.['completed'] === true,
        archived: false,
        comments: withComments ? await asanaComments(fetcher, headers, gid) : null,
      });
    }
    if (truncated) break;
    const next = str(rec(body?.['next_page'])?.['offset']);
    if (next === null || next.length > 512) break;
    offset = next;
  }
  return { containers: sections, people: [...people.values()], cards, truncated };
}

async function asanaComments(
  fetcher: PmFetch,
  headers: Record<string, string>,
  taskGid: string,
): Promise<PmComment[]> {
  const stories = list(
    rec(
      await pmGetJson(
        fetcher,
        `${ASANA}/tasks/${taskGid}/stories?opt_fields=type,resource_subtype,text,created_at,created_by.name`,
        headers,
      ),
    )?.['data'],
  );
  return stories
    .flatMap((raw) => {
      const story = rec(raw);
      if (story?.['resource_subtype'] !== 'comment_added' && story?.['type'] !== 'comment') {
        return [];
      }
      const text = str(story?.['text']);
      if (text === null) return [];
      return [
        {
          authorName: cut(str(rec(story?.['created_by'])?.['name']) ?? '', 200),
          text,
          createdAt: str(story?.['created_at']),
        },
      ];
    })
    .slice(0, MAX_PM_COMMENTS_PER_CARD);
}

// ─── The source facade ───────────────────────────────────────────────────

/** A cheap call proving the credential works; throws `PmFetchError('pm_auth_failed')` if not. */
export async function verifyPmCredential(
  fetcher: PmFetch,
  credential: PmCredential,
): Promise<void> {
  const url =
    credential.source === 'trello' ? `${TRELLO}/members/me?fields=id` : `${ASANA}/users/me`;
  await pmGetJson(fetcher, url, authHeaders(credential));
}

export function listPmBoards(fetcher: PmFetch, credential: PmCredential): Promise<PmBoard[]> {
  return credential.source === 'trello'
    ? trelloBoards(fetcher, credential)
    : asanaBoards(fetcher, credential);
}

/** Read the chosen boards / projects, merged, at most {@link MAX_PM_CARDS} cards. */
export async function readPmBoards(
  fetcher: PmFetch,
  credential: PmCredential,
  boardIds: readonly string[],
  withComments: boolean,
): Promise<PmBoardData> {
  if (boardIds.length === 0 || boardIds.length > MAX_PM_BOARDS) {
    throw new PmFetchError('pm_bad_response', 'Choose between 1 and 10 boards');
  }
  const containers = new Set<string>();
  const people = new Map<string, PmPerson>();
  const cards: PmCard[] = [];
  let truncated = false;
  for (const id of boardIds) {
    if (!isPmBoardId(credential.source, id)) {
      throw new PmFetchError('pm_not_found', 'The service could not find that item');
    }
    const room = MAX_PM_CARDS - cards.length;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const data =
      credential.source === 'trello'
        ? await trelloBoard(fetcher, credential, id, withComments, room)
        : await asanaBoard(fetcher, credential, id, withComments, room);
    data.containers.forEach((c) => containers.add(c));
    data.people.forEach((p) => people.set(p.key, p));
    cards.push(...data.cards);
    truncated ||= data.truncated;
  }
  return { containers: [...containers], people: [...people.values()], cards, truncated };
}
