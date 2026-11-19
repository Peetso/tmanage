'use client';

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  InlineAlert,
  LoadingRegion,
  Select,
  Skeleton,
  Switch,
  Toast,
  ToastRegion,
} from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { NavIcon } from '../icons/phone';
import { UnsavedChangesGuard } from '../permissions/UnsavedChangesGuard';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import { ApiRequestError } from '../../lib/api/errors';
import {
  getSignalSettings,
  signalSettingsQueryKey,
  updateSignalSettings,
} from '../../lib/api/signals';
import type {
  SignalRecipient,
  SignalRuleKey,
  SignalSettingInput,
  SignalSettingView,
  SignalSettingsView,
} from '../../lib/api/signals';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  ALERTS_COPY,
  meaningKey,
  recipientKey,
  ruleKey,
  unitKey,
  type AlertsCopyKey,
} from './alert-settings-copy';
import { fillHoles } from './home-briefing-copy';
import '../../styles/screens/alert-settings.css';

/**
 * **Settings → Alerts** (62-27, B12; FIGMA-D group c, fixes 23–32). The owner's eight signal rules:
 * on or off, the threshold, who is told. Everything the rows offer — units, limits, recipient
 * choices, which rules are money rules — comes from the server's catalogue; this screen draws it.
 *
 * - Owner only: the route answers 403 to anyone else (they are not given the page in the menu),
 *   and 404 while the company's `business_briefing` flag is off.
 * - A money rule is told to the finance team only: fixed text with a lock, not a control (fix 24).
 * - Off dims and disables the threshold and recipient, keeping their values (fix 26). Off stops
 *   the notices only; the briefing on Home still lists the rule's findings (fix 27).
 * - Save is offered once something changed, is busy while it saves, then says so in a toast;
 *   leaving with unsaved changes asks first (fix 29).
 */

export interface AlertSettingsScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** Injected in tests and stories. Defaults to the browser client. */
  readonly client?: ApiClient | undefined;
}

type Text = (key: AlertsCopyKey) => string;

/** One rule as the owner is editing it; the threshold is the text in the box. */
interface Draft {
  readonly enabled: boolean;
  readonly threshold: string;
  readonly recipient: SignalRecipient;
}

type Drafts = Readonly<Record<SignalRuleKey, Draft>>;

function draftsOf(rules: readonly SignalSettingView[]): Drafts {
  return Object.fromEntries(
    rules.map((rule) => [
      rule.rule,
      { enabled: rule.enabled, threshold: String(rule.threshold), recipient: rule.recipient },
    ]),
  ) as Drafts;
}

/** The whole number in the box when it is inside the rule's limits, else null. */
function thresholdValue(text: string, rule: Pick<SignalSettingView, 'min' | 'max'>) {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= rule.min && value <= rule.max ? value : null;
}

function changed(rule: SignalSettingView, draft: Draft): boolean {
  return (
    draft.enabled !== rule.enabled ||
    draft.recipient !== rule.recipient ||
    draft.threshold.trim() !== String(rule.threshold)
  );
}

export function AlertSettingsScreen({
  organizationSlug,
  organizationName,
  client,
}: AlertSettingsScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const text: Text = (key) => tOr(key, ALERTS_COPY[key]);
  const errorMessage = useDescribeApiError(OFFLINE_LINES);

  const settings = useQuery({
    queryKey: signalSettingsQueryKey(organizationSlug),
    queryFn: () => getSignalSettings(api, organizationSlug),
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="alerts"
      crumbs={[text('AlertSettings.crumb')]}
      title={text('AlertSettings.title')}
      description={text('AlertSettings.lead')}
      {...(client === undefined ? {} : { client })}
    >
      {settings.isPending ? (
        <LoadingRegion label={text('AlertSettings.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : settings.isError ? (
        settings.error instanceof ApiRequestError && settings.error.status === 403 ? (
          <InlineAlert>{text('AlertSettings.ownerOnly')}</InlineAlert>
        ) : (
          <InlineAlert tone="danger" title={text('AlertSettings.loadFailed')}>
            {errorMessage(settings.error)}
          </InlineAlert>
        )
      ) : settings.data === null ? (
        <InlineAlert>{text('AlertSettings.off')}</InlineAlert>
      ) : (
        <AlertRulesForm
          organizationSlug={organizationSlug}
          api={api}
          view={settings.data}
          text={text}
        />
      )}
    </ControlCenterShell>
  );
}

function AlertRulesForm({
  organizationSlug,
  api,
  view,
  text,
}: {
  readonly organizationSlug: string;
  readonly api: ApiClient;
  readonly view: SignalSettingsView;
  readonly text: Text;
}) {
  const queries = useQueryClient();
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const formId = useId();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(view.rules));
  const [savedToast, setSavedToast] = useState(false);

  const changedRules = useMemo(
    () => view.rules.filter((rule) => changed(rule, drafts[rule.rule])),
    [view.rules, drafts],
  );
  const dirty = changedRules.length > 0;
  const invalid = view.rules.filter(
    (rule) => thresholdValue(drafts[rule.rule].threshold, rule) === null,
  );

  const save = useMutation({
    mutationFn: (rules: readonly SignalSettingInput[]) =>
      updateSignalSettings(api, organizationSlug, rules),
    onSuccess: (result) => {
      queries.setQueryData(signalSettingsQueryKey(organizationSlug), result);
      setDrafts(draftsOf(result.rules));
      setSavedToast(true);
    },
  });

  useEffect(() => {
    if (!savedToast) return undefined;
    const timer = setTimeout(() => setSavedToast(false), 6000);
    return () => clearTimeout(timer);
  }, [savedToast]);

  const update = (rule: SignalRuleKey, patch: Partial<Draft>) => {
    setSavedToast(false);
    setDrafts((current) => ({ ...current, [rule]: { ...current[rule], ...patch } }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const first = invalid[0];
    if (first !== undefined) {
      document.getElementById(thresholdId(formId, first.rule))?.focus();
      return;
    }
    save.mutate(
      view.rules.map((rule) => {
        const draft = drafts[rule.rule];
        return {
          rule: rule.rule,
          enabled: draft.enabled,
          threshold: thresholdValue(draft.threshold, rule) ?? rule.threshold,
          recipient: draft.recipient,
        };
      }),
    );
  };

  const leaveBody =
    changedRules.length === 1
      ? text('AlertSettings.leaveBodyOne')
      : fillHoles(text('AlertSettings.leaveBody'), { count: String(changedRules.length) });

  return (
    <form className="tm-alerts" onSubmit={submit} noValidate>
      <div className="tm-alerts__card">
        <div className="tm-alerts__head" aria-hidden="true">
          <span>{text('AlertSettings.columnRule')}</span>
          <span>{text('AlertSettings.columnThreshold')}</span>
          <span>{text('AlertSettings.columnRecipient')}</span>
        </div>
        <ul className="tm-alerts__rows">
          {view.rules.map((rule) => (
            <AlertRuleRow
              key={rule.rule}
              formId={formId}
              rule={rule}
              draft={drafts[rule.rule]}
              text={text}
              onChange={(patch) => update(rule.rule, patch)}
            />
          ))}
        </ul>
      </div>

      <InlineAlert>{text('AlertSettings.offMeans')}</InlineAlert>

      {save.isError ? (
        <InlineAlert tone="danger" title={text('AlertSettings.saveFailed')} live>
          {errorMessage(save.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-alerts__actions">
        <Button
          type="submit"
          disabled={!dirty}
          loading={save.isPending}
          loadingLabel={text('AlertSettings.saving')}
        >
          {text('AlertSettings.save')}
        </Button>
        <Button
          tone="outline"
          disabled={!dirty || save.isPending}
          onClick={() => {
            save.reset();
            setDrafts(draftsOf(view.rules));
          }}
        >
          {text('AlertSettings.cancel')}
        </Button>
      </div>

      <ToastRegion>
        {savedToast ? (
          <Toast
            tone="success"
            onDismiss={() => setSavedToast(false)}
            dismissLabel={text('AlertSettings.dismiss')}
          >
            {text('AlertSettings.saved')}
          </Toast>
        ) : null}
      </ToastRegion>

      <UnsavedChangesGuard
        when={dirty && !save.isPending}
        body={leaveBody}
        changes={changedRules.map((rule) => text(ruleKey(rule.rule)))}
      />
    </form>
  );
}

const thresholdId = (formId: string, rule: SignalRuleKey) => `${formId}-${rule}-threshold`;

function AlertRuleRow({
  formId,
  rule,
  draft,
  text,
  onChange,
}: {
  readonly formId: string;
  readonly rule: SignalSettingView;
  readonly draft: Draft;
  readonly text: Text;
  readonly onChange: (patch: Partial<Draft>) => void;
}) {
  const name = text(ruleKey(rule.rule));
  const inputId = thresholdId(formId, rule.rule);
  const unitId = `${inputId}-unit`;
  const errorId = `${inputId}-error`;
  const error =
    thresholdValue(draft.threshold, rule) === null
      ? fillHoles(text('AlertSettings.thresholdError'), {
          min: String(rule.min),
          max: String(rule.max),
        })
      : null;
  // A money rule has one recipient, told as fixed text (fix 24); an empty list is never offered.
  const fixed = rule.money || rule.recipients.length <= 1;
  // The accessible name says the row and the column (fix 25); the visible label (phone) the column.
  const labelOf = (column: AlertsCopyKey) =>
    fillHoles(text('AlertSettings.fieldLabel'), { rule: name, column: text(column) });

  return (
    <li className={`tm-alerts__row${draft.enabled ? '' : ' tm-alerts__row--off'}`}>
      <Switch
        className="tm-alerts__rule"
        label={name}
        hint={
          <>
            {text(meaningKey(rule.rule))}
            {rule.money ? (
              <span className="tm-alerts__finance">{text('AlertSettings.financeOnly')}</span>
            ) : null}
          </>
        }
        checked={draft.enabled}
        onChange={(event) => onChange({ enabled: event.target.checked })}
      />

      <div className="tm-alerts__cell">
        <label className="tm-alerts__label" htmlFor={inputId}>
          {text('AlertSettings.columnThreshold')}
        </label>
        <span className="tm-alerts__number">
          <input
            id={inputId}
            className="tm-field__control"
            type="number"
            inputMode="numeric"
            step={1}
            min={rule.min}
            max={rule.max}
            value={draft.threshold}
            disabled={!draft.enabled}
            aria-label={labelOf('AlertSettings.columnThreshold')}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={error === null ? unitId : `${unitId} ${errorId}`}
            onChange={(event) => onChange({ threshold: event.target.value })}
          />
          <span className="tm-alerts__unit" id={unitId}>
            {text(unitKey(rule.unit))}
          </span>
        </span>
        {error === null ? null : (
          <span className="tm-field__error" id={errorId}>
            <span className="tm-inline-alert__glyph" aria-hidden="true">
              !
            </span>
            {error}
          </span>
        )}
      </div>

      <div className="tm-alerts__cell">
        {fixed ? (
          <>
            <span className="tm-alerts__label">{text('AlertSettings.columnRecipient')}</span>
            <p className="tm-alerts__fixed">
              <NavIcon name="lock" size={16} className="tm-alerts__lock" />
              {text(recipientKey(draft.recipient))}
            </p>
          </>
        ) : (
          <Select
            className="tm-alerts__select"
            label={text('AlertSettings.columnRecipient')}
            aria-label={labelOf('AlertSettings.columnRecipient')}
            value={draft.recipient}
            disabled={!draft.enabled}
            onChange={(event) => {
              const next = rule.recipients.find((choice) => choice === event.target.value);
              if (next !== undefined) onChange({ recipient: next });
            }}
          >
            {rule.recipients.map((choice) => (
              <option key={choice} value={choice}>
                {text(recipientKey(choice))}
              </option>
            ))}
          </Select>
        )}
      </div>
    </li>
  );
}
