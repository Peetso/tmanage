'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, InlineAlert } from '@tmanage/ui';
import {
  createAgentKey,
  type AiEmployeeView,
  type CreatedAgentKeyView,
} from '../../lib/api/ai-employees';
import type { ApiClient } from '../../lib/api/client';
import { connectorAddress, deploymentAddress } from '../../lib/ai-connector-address';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { fill } from '../people/ChangeRoleDialog';
import { CopyField, FieldLabel, SelectBox } from './AiField';
import { DotsIcon, SparkIcon } from './ai-icons';
import { KEY_LIFETIMES, type KeyLifetime } from './ai-employee-model';

export type ConnectChoice = 'claude' | 'chatgpt' | 'other';

/** The deployment's MCP address, read after hydration (the same one Settings › AI assistant shows). */
function useConnectorAddress(override?: string): string {
  const [address, setAddress] = useState(override ?? '');
  useEffect(() => {
    if (override !== undefined) return;
    const origin = deploymentAddress();
    setAddress(origin === '' ? '' : connectorAddress(origin));
  }, [override]);
  return address;
}

/**
 * S4 Connect (Figma `952:1036`, `964:7104`, `952:2172`): Claude, ChatGPT or another agent.
 *
 * - Claude and ChatGPT: the connector address with Copy and three numbered steps. The agent opens
 *   TManage's consent page, where the person picks "Works as: Mat" (S5, lane A).
 * - Other: choose how long the key lives (30, 60 or 90 days), then Create key; the key is shown
 *   once, with the "copy it now" alert, its expiry as plain text, and the same address.
 *
 * Used by the hire wizard (step 3) and by the profile's "Add connection".
 */
export function ConnectPanel({
  api,
  organizationSlug,
  ai,
  choice,
  onChoice,
  createdKey,
  onKeyCreated,
  addressOverride,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly ai: AiEmployeeView;
  readonly choice: ConnectChoice;
  readonly onChoice: (choice: ConnectChoice) => void;
  readonly createdKey: CreatedAgentKeyView | null;
  readonly onKeyCreated: (key: CreatedAgentKeyView) => void;
  /** Stories: the address the design shows. */
  readonly addressOverride?: string;
}) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const describe = useDescribeApiError();
  const group = useId();
  const expiresId = useId();
  const address = useConnectorAddress(addressOverride);
  const [lifetime, setLifetime] = useState<KeyLifetime>(90);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = ai.displayName;

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const key = await createAgentKey(api, organizationSlug, ai.id, {
        name: tOr('AiConnect.keyName', 'Agent key'),
        lifetimeDays: lifetime,
      });
      onKeyCreated(key);
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const options: readonly { id: ConnectChoice; label: string; icon: ReactNode }[] = [
    { id: 'claude', label: 'Claude', icon: <SparkIcon /> },
    { id: 'chatgpt', label: 'ChatGPT', icon: <SparkIcon /> },
    { id: 'other', label: tOr('AiConnect.other', 'Other agent or tool'), icon: <DotsIcon /> },
  ];
  const app = choice === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const steps =
    choice === 'chatgpt'
      ? [
          tOr('AiConnect.chatgptStep1', 'In ChatGPT, open Settings › Connectors.'),
          tOr('AiConnect.chatgptStep2', 'Create a connector and paste the address.'),
        ]
      : [
          tOr('AiConnect.claudeStep1', 'In Claude, open Settings › Connectors.'),
          tOr('AiConnect.claudeStep2', 'Add a custom connector and paste the address.'),
        ];
  const day = (iso: string | null) =>
    iso === null
      ? ''
      : new Intl.DateTimeFormat(withNumerals(locale), {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(Date.parse(iso));

  return (
    <div className="tm-aie-connect">
      <fieldset className="tm-aie-apps">
        <legend className="tm-visually-hidden">
          {tOr('AiConnect.chooseApp', 'How his agent connects')}
        </legend>
        {options.map((option) => (
          <label
            key={option.id}
            className="tm-aie-app"
            data-chosen={choice === option.id || undefined}
          >
            <input
              type="radio"
              name={group}
              className="tm-visually-hidden"
              checked={choice === option.id}
              onChange={() => onChoice(option.id)}
            />
            <span className="tm-aie-app__icon" aria-hidden="true">
              {option.icon}
            </span>
            <span className="tm-aie-app__name">{option.label}</span>
          </label>
        ))}
      </fieldset>

      {choice !== 'other' ? (
        <>
          <CopyField
            label={tOr('AiConnect.connectorAddress', 'Connector address')}
            value={address}
          />
          <ol
            className="tm-aie-steps"
            aria-label={fill(tOr('AiConnect.stepsIn', 'Steps in {app}'), { app })}
          >
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
            <li>
              {fill(tOr('AiConnect.pickWorksAs', 'Sign in, then pick “Works as: {name}”.'), {
                name,
              })}
            </li>
          </ol>
        </>
      ) : createdKey === null ? (
        <>
          <div className="tm-team-dialog__field">
            <FieldLabel
              htmlFor={expiresId}
              label={tOr('AiConnect.expires', 'Expires')}
              info={tOr(
                'AiConnect.expiresInfo',
                'The key stops working on this date. The longest is 90 days. Make a new key before then.',
              )}
            />
            <SelectBox
              id={expiresId}
              value={lifetime}
              onChange={(event) => setLifetime(Number(event.target.value) as KeyLifetime)}
            >
              {KEY_LIFETIMES.map((days) => (
                <option key={days} value={days}>
                  {fill(tOr('AiConnect.inDays', 'In {count} days'), {
                    count: days.toLocaleString(withNumerals(locale)),
                  })}
                </option>
              ))}
            </SelectBox>
          </div>
          <div className="tm-aie-row">
            <Button
              type="button"
              tone="lime"
              size="header"
              loading={busy}
              onClick={() => void create()}
            >
              {tOr('AiConnect.createKey', 'Create key')}
            </Button>
          </div>
          <p className="tm-aie-quiet">
            {tOr('AiConnect.shownOnce', 'The key is shown once, right after you create it.')}
          </p>
          {problem ? (
            <p className="tm-team-dialog__problem" role="alert">
              {problem}
            </p>
          ) : null}
          <CopyField label={tOr('AiConnect.address', 'Address')} value={address} />
          <AgentGuideLink organizationSlug={organizationSlug} />
        </>
      ) : (
        <>
          <InlineAlert tone="warning" live>
            {tOr('AiConnect.copyNow', 'Copy this key now. You won’t see it again.')}
          </InlineAlert>
          <CopyField label={tOr('AiConnect.agentKey', 'Agent key')} value={createdKey.token} />
          <p className="tm-aie-quiet">
            {fill(
              tOr(
                'AiConnect.keyExpires',
                'Expires in {count} days, on {date}. To change it, make a new key.',
              ),
              {
                count: keyDays(createdKey).toLocaleString(withNumerals(locale)),
                date: day(createdKey.expiresAt),
              },
            )}
          </p>
          <CopyField label={tOr('AiConnect.address', 'Address')} value={address} />
          <AgentGuideLink organizationSlug={organizationSlug} />
        </>
      )}
    </div>
  );
}

/** The key's life in whole days, from its own dates (not the menu, which may have moved). */
function keyDays(key: CreatedAgentKeyView): number {
  if (key.expiresAt === null) return 0;
  return Math.round((Date.parse(key.expiresAt) - Date.parse(key.createdAt)) / 86_400_000);
}

function AgentGuideLink({ organizationSlug }: { readonly organizationSlug: string }) {
  const tOr = useTOr();
  return (
    <Link className="tm-aie-link" href={`/${organizationSlug}/help/connect-ai`}>
      {tOr('AiConnect.agentGuide', 'Read the agent guide')}
    </Link>
  );
}
