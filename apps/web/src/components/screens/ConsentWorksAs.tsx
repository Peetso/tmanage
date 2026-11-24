'use client';

import type { ReactNode } from 'react';
import { Avatar, Button, InfoButton } from '@tmanage/ui';
import { AiAvatar, AiBadge } from '../ai-employees/AiBadge';
import type { WorksAsOptionView, WorksAsUnavailableReason } from '../../lib/api/oauth-consent';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/consent-works-as.css';

/**
 * **S5 Consent — "This agent works as"** (plan 60 v2 §4.5, slice 60-07; Figma 953:1464 EN desktop,
 * 953:1571 EN phone, 953:1678 AR desktop, 953:1785 AR phone).
 *
 * The consent page's variant for a person who may connect the app as one of the workspace's AI
 * employees: a radio list of "Me" and each AI employee (AI avatar, name, AI mark, job title),
 * unavailable ones dimmed with the reason in the muted colour (Fable R2: only the avatar, name and
 * radio are dimmed). With an AI employee chosen, the page says in plain words what it can and can
 * never do; with "Me" chosen, the ordinary scope switches show (`meDetails`). The choice is only
 * a request: the API re-checks, on the server, that this person may bind that AI employee.
 *
 * Presentational: the screen (`ConsentScreen`) owns the queries and the decision.
 */

export const WORKS_AS_ME = 'me';

export interface ConsentWorksAsProps {
  readonly appName: string;
  /** The signed-in person's name, once known. */
  readonly personName: string | null;
  readonly workspaceName: string;
  /** The person's role in this workspace, already translated ("Owner"). */
  readonly roleLabel: string | null;
  readonly options: readonly WorksAsOptionView[];
  /** {@link WORKS_AS_ME} or an AI employee id. */
  readonly choice: string;
  readonly onChoose: (choice: string) => void;
  readonly onNotYou: () => void;
  readonly notYouPending?: boolean;
  /** Who the app is and where the code goes (threat model B2: shown on every consent). */
  readonly clientCard: ReactNode;
  /** The workspace picker, only when the person belongs to more than one. */
  readonly workspacePicker: ReactNode;
  /** The ordinary scope switches and "never" list, shown while "Me" is chosen. */
  readonly meDetails: ReactNode;
  readonly failure: ReactNode;
  readonly onCancel: () => void;
  readonly cancelPending: boolean;
  readonly onAllow: () => void;
  readonly allowPending: boolean;
}

const CAN: ReadonlyArray<readonly [string, string]> = [
  ['ConsentWorksAs.can.read', 'Read the work he is given'],
  ['ConsentWorksAs.can.ask', 'Ask questions in the task'],
  ['ConsentWorksAs.can.upload', 'Upload files for review'],
];

const NEVER: ReadonlyArray<readonly [string, string]> = [
  ['ConsentWorksAs.never.publish', 'Delete, publish or send'],
  ['ConsentWorksAs.never.pay', 'Pay or change settings'],
];

const REASONS: Readonly<Record<WorksAsUnavailableReason, readonly [string, string]>> = {
  paused: ['ConsentWorksAs.reason.paused', 'Paused'],
  not_allowed: ['ConsentWorksAs.reason.notAllowed', 'Not allowed'],
  limit: ['ConsentWorksAs.reason.limit', 'No free connection'],
};

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/**
 * The AI avatar's letters: first and last initial of a longer name, the first two letters of a
 * one-word Latin name ("MA"), one letter of a one-word name in a script without case («ز»).
 */
export function aiInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = [...(words[0] ?? '')];
  if (words.length > 1) {
    const last = [...(words[words.length - 1] ?? '')];
    return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
  }
  const lead = first[0] ?? '';
  if (lead !== '' && lead.toUpperCase() === lead.toLowerCase()) return lead;
  return first.slice(0, 2).join('').toUpperCase();
}

export function ConsentWorksAs(props: ConsentWorksAsProps) {
  const tOr = useTOr();
  const chosen = props.options.find((option) => option.id === props.choice) ?? null;
  const me = props.personName ?? '';
  const identity = [props.personName, props.workspaceName].filter(Boolean).join(' · ');

  return (
    <>
      <h1 className="tm-consent__title">
        {fill(tOr('ConsentWorksAs.title', '{app} wants to connect to TManage'), {
          app: props.appName,
        })}
      </h1>
      {props.clientCard}

      <div className="tm-works-as__identity">
        {props.personName ? <Avatar name={props.personName} size="compact" decorative /> : null}
        <span className="tm-works-as__identity-text">{identity}</span>
        <Button
          tone="text"
          flush
          className="tm-works-as__not-you"
          loading={props.notYouPending === true}
          onClick={props.onNotYou}
        >
          {tOr('ConsentWorksAs.notYou', 'Not you?')}
        </Button>
      </div>

      {props.workspacePicker}

      <fieldset className="tm-works-as" role="radiogroup" aria-labelledby="tm-works-as-legend">
        <legend className="tm-works-as__legend">
          <span id="tm-works-as-legend">{tOr('ConsentWorksAs.legend', 'This agent works as')}</span>
          <InfoButton
            title={tOr('ConsentWorksAs.legend', 'This agent works as')}
            label={tOr('ConsentWorksAs.infoLabel', 'About who the agent works as')}
          >
            {chosen
              ? fill(
                  tOr(
                    'ConsentWorksAs.info',
                    'Everything this agent does shows as {name}, never as you. It can only do what {name} may do.',
                  ),
                  { name: chosen.displayName },
                )
              : tOr(
                  'ConsentWorksAs.infoAny',
                  'Everything this agent does shows as the AI employee you choose, never as you. It can only do what that AI employee may do.',
                )}
          </InfoButton>
        </legend>
        <ul className="tm-works-as__list">
          <li className="tm-works-as__row">
            <input
              id="tm-works-as-me"
              type="radio"
              name="tm-works-as"
              className="tm-radio"
              value={WORKS_AS_ME}
              checked={props.choice === WORKS_AS_ME}
              onChange={() => props.onChoose(WORKS_AS_ME)}
            />
            {props.personName ? <Avatar name={props.personName} size="compact" decorative /> : null}
            <label htmlFor="tm-works-as-me" className="tm-works-as__text">
              <span className="tm-works-as__name">
                {me === ''
                  ? tOr('ConsentWorksAs.meAlone', 'Me')
                  : fill(tOr('ConsentWorksAs.me', 'Me ({name})'), { name: me })}
              </span>
              {props.roleLabel ? <span className="tm-works-as__sub">{props.roleLabel}</span> : null}
            </label>
          </li>
          {props.options.map((option) => {
            const id = `tm-works-as-${option.id}`;
            const reason = option.unavailableReason ? REASONS[option.unavailableReason] : null;
            return (
              <li
                key={option.id}
                className="tm-works-as__row"
                data-unavailable={option.available ? undefined : 'true'}
              >
                <input
                  id={id}
                  type="radio"
                  name="tm-works-as"
                  className="tm-radio tm-works-as__dim"
                  value={option.id}
                  checked={props.choice === option.id}
                  disabled={!option.available}
                  aria-describedby={reason ? `${id}-reason` : undefined}
                  onChange={() => props.onChoose(option.id)}
                />
                <span className="tm-works-as__dim">
                  <AiAvatar initials={aiInitials(option.displayName)} />
                </span>
                <label htmlFor={id} className="tm-works-as__text">
                  <span className="tm-works-as__name-row">
                    <span className="tm-works-as__name tm-works-as__dim">{option.displayName}</span>
                    <AiBadge />
                  </span>
                  <span className="tm-works-as__sub">{option.jobTitle}</span>
                </label>
                {reason ? (
                  <span id={`${id}-reason`} className="tm-works-as__reason">
                    {tOr(reason[0], reason[1])}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </fieldset>

      {chosen ? (
        <div className="tm-works-as__powers">
          <section aria-labelledby="tm-works-as-can">
            <p id="tm-works-as-can" className="tm-works-as__powers-title">
              {fill(tOr('ConsentWorksAs.canTitle', '{name} can'), { name: chosen.displayName })}
            </p>
            <ul className="tm-works-as__powers-list">
              {CAN.map(([key, english]) => (
                <li key={key} className="tm-works-as__power">
                  <span className="tm-works-as__glyph" aria-hidden="true">
                    ✓
                  </span>
                  <span>{tOr(key, english)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="tm-works-as-never">
            <p id="tm-works-as-never" className="tm-works-as__powers-title">
              {fill(tOr('ConsentWorksAs.neverTitle', '{name} can never'), {
                name: chosen.displayName,
              })}
            </p>
            <ul className="tm-works-as__powers-list">
              {NEVER.map(([key, english]) => (
                <li key={key} className="tm-works-as__power">
                  <span className="tm-works-as__glyph" aria-hidden="true">
                    ✕
                  </span>
                  <span>{tOr(key, english)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : (
        props.meDetails
      )}

      {props.failure}
      <div className="tm-works-as__actions">
        <Button tone="text" loading={props.cancelPending} onClick={props.onCancel}>
          {tOr('ConsentWorksAs.cancel', 'Cancel')}
        </Button>
        <Button
          tone="lime"
          loading={props.allowPending}
          loadingLabel={tOr('ConsentWorksAs.allowing', 'Connecting')}
          onClick={props.onAllow}
        >
          {tOr('ConsentWorksAs.allow', 'Allow')}
        </Button>
      </div>
    </>
  );
}
