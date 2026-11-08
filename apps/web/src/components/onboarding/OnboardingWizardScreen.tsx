'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Field,
  InlineAlert,
  LimeButton,
  LoadingRegion,
  OutlineButton,
  Radio,
  RadioGroup,
  Skeleton,
  TextButton,
} from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  dismissOnboardingWizard,
  getOnboardingWizard,
  recordOnboardingWizardStep,
  type OnboardingWizardView,
  type WizardOutcome,
  type WizardStep,
} from '../../lib/api/onboarding-wizard';
import { readOrganizationProfile, renameOrganization } from '../../lib/api/organizations';
import { LOGO_IMAGE_ACCEPT, uploadOrganizationLogoImage } from '../../lib/api/organization-logo';
import { setOrgSetting } from '../../lib/api/org-settings';
import { issueInvitation } from '../../lib/api/invitations';
import { getStorageStatus, startDriveConnect } from '../../lib/api/google-drive';
import { getOneDriveStatus, startOneDriveConnect } from '../../lib/api/onedrive';
import {
  installTemplatePack,
  listTemplatePacks,
  type PackRole,
} from '../../lib/api/template-packs';
import { filterTemplatePacks } from '../../lib/onboarding/template-pack-filter';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { PackRoleFilter } from '../projects/TemplatePacksGallery';
import { instantiateProjectTemplate, listProjectTemplates } from '../../lib/api/project-templates';
import { listWorkspaces } from '../../lib/api/projects';
import { INVITABLE_ROLES } from '../../lib/roles';
import { useTOr } from '../../lib/i18n/use-t-or';
import {
  WIZARD_STEP_ORDER,
  nextStep,
  parseInviteEmails,
  previousStep,
} from '../../lib/onboarding/wizard';

export interface OnboardingWizardScreenProps {
  readonly organizationSlug: string;
  /** Where Finish and "Skip setup" go: My Day. */
  readonly onLeave: () => void;
  /** Sends the browser to a storage provider's consent screen. */
  readonly onExternalRedirect?: (url: string) => void;
  readonly client?: ApiClient;
}

const STEP_LABEL: Readonly<Record<WizardStep, readonly [string, string]>> = {
  company: ['OnboardingWizard.step.company', 'Company'],
  work_type: ['OnboardingWizard.step.workType', 'Work type'],
  invite: ['OnboardingWizard.step.invite', 'Invite your team'],
  storage: ['OnboardingWizard.step.storage', 'Connect storage'],
  sample_project: ['OnboardingWizard.step.sampleProject', 'Sample project'],
  finish: ['OnboardingWizard.step.finish', 'Finish'],
};

const WORK_TYPES = [
  ['delivery-client-review', 'workType.delivery', 'Client work with reviews'],
  ['intake-commitment', 'workType.intake', 'Requests and commitments'],
  ['internal-delivery', 'workType.internal', 'Internal projects'],
  ['empty', 'workType.empty', 'Start from empty'],
] as const;

/**
 * **55-01 / 55-01a / 55-03 — the three-minute onboarding wizard.**
 *
 * Six steps after sign-up: company name and logo, work type, invite teammates, connect storage
 * (Google Drive or OneDrive through the existing connect flow), a sample project from a template
 * pack (55-02: filtered by the person's role; 54-23: Arabic agency packs first in Arabic, Figma
 * section "R50 L2"), and Finish to My Day. Every step but Finish can be skipped, "Skip setup" leaves at any
 * time, and the position is stored per company (`onboarding_wizard`) so a reload or a return from
 * the storage provider resumes where it was. The layout uses logical properties, so Arabic mirrors.
 */
export function OnboardingWizardScreen({
  organizationSlug,
  onLeave,
  onExternalRedirect = (url) => window.location.assign(url),
  client,
}: OnboardingWizardScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const t = (key: string, english: string) => tOr(`OnboardingWizard.${key}`, english);
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const queryKey = ['onboarding-wizard', organizationSlug];

  const wizard = useQuery({ queryKey, queryFn: () => getOnboardingWizard(api, organizationSlug) });
  const [current, setCurrent] = useState<WizardStep | null>(null);
  useEffect(() => {
    if (current === null && wizard.data) setCurrent(wizard.data.currentStep);
  }, [current, wizard.data]);

  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: async (input: {
      step: WizardStep;
      outcome: WizardOutcome;
      work?: (() => Promise<void>) | undefined;
    }) => {
      if (input.work) await input.work();
      return recordOnboardingWizardStep(api, organizationSlug, input.step, input.outcome);
    },
    onMutate: () => setError(null),
    onSuccess: (view: OnboardingWizardView, input) => {
      queryClient.setQueryData(queryKey, view);
      if (input.step === 'finish') onLeave();
      else setCurrent(nextStep(input.step));
    },
    onError: (cause) => setError(describeError(cause)),
  });

  const dismiss = useMutation({
    mutationFn: () => dismissOnboardingWizard(api, organizationSlug),
    onSuccess: () => onLeave(),
    onError: (cause) => setError(describeError(cause)),
  });

  const step = current;
  const outcomes = new Map(wizard.data?.steps.map((entry) => [entry.step, entry.outcome]) ?? []);
  const busy = record.isPending || dismiss.isPending;

  return (
    <div className="tm-obw">
      <style href="tm-onboarding-wizard" precedence="default">
        {WIZARD_CSS}
      </style>
      <header className="tm-obw__header">
        <span className="tm-obw__brand">TManage</span>
        <TextButton onClick={() => dismiss.mutate()} disabled={busy}>
          {t('skipSetup', 'Skip setup')}
        </TextButton>
      </header>

      {wizard.isError ? (
        <InlineAlert tone="danger">{describeError(wizard.error)}</InlineAlert>
      ) : step === null ? (
        <LoadingRegion label={t('loading', 'Loading your setup')}>
          <Skeleton />
        </LoadingRegion>
      ) : (
        <div className="tm-obw__body">
          <nav className="tm-obw__rail" aria-label={t('stepsLabel', 'Setup steps')}>
            <h1 className="tm-obw__rail-title">{t('title', 'Set up your workspace')}</h1>
            <p className="tm-obw__rail-sub">{t('duration', 'About three minutes')}</p>
            <ol className="tm-obw__steps">
              {WIZARD_STEP_ORDER.map((entry, index) => {
                const state = entry === step ? 'current' : outcomes.get(entry) ? 'done' : 'pending';
                const [key, english] = STEP_LABEL[entry];
                return (
                  <li
                    key={entry}
                    className="tm-obw__step"
                    data-state={state}
                    aria-current={state === 'current' ? 'step' : undefined}
                  >
                    <span className="tm-obw__marker" aria-hidden="true">
                      {state === 'done' ? '✓' : index + 1}
                    </span>
                    {tOr(key, english)}
                  </li>
                );
              })}
            </ol>
          </nav>

          <section className="tm-obw__panel" aria-labelledby="tm-obw-step-title">
            <p className="tm-obw__eyebrow">
              {t('stepOf', 'Step {n} of {total}')
                .replace('{n}', String(WIZARD_STEP_ORDER.indexOf(step) + 1))
                .replace('{total}', String(WIZARD_STEP_ORDER.length))}
            </p>
            {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
            <StepPanel
              key={step}
              step={step}
              api={api}
              organizationSlug={organizationSlug}
              t={t}
              busy={busy}
              onBack={() => setCurrent(previousStep(step) ?? step)}
              onRecord={(outcome, work) => record.mutate({ step, outcome, work })}
              onRedirect={onExternalRedirect}
              onError={(cause) => setError(describeError(cause))}
            />
          </section>
        </div>
      )}
    </div>
  );
}

interface StepPanelProps {
  readonly step: WizardStep;
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly t: (key: string, english: string) => string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onRecord: (outcome: WizardOutcome, work?: () => Promise<void>) => void;
  readonly onRedirect: (url: string) => void;
  readonly onError: (cause: unknown) => void;
}

function StepPanel(props: StepPanelProps) {
  switch (props.step) {
    case 'company':
      return <CompanyStep {...props} />;
    case 'work_type':
      return <WorkTypeStep {...props} />;
    case 'invite':
      return <InviteStep {...props} />;
    case 'storage':
      return <StorageStep {...props} />;
    case 'sample_project':
      return <SampleProjectStep {...props} />;
    case 'finish':
      return <FinishStep {...props} />;
  }
}

/** Title, description, the step's body, then Back · Skip this step · Continue. */
function StepFrame({
  props,
  title,
  description,
  children,
  onContinue,
  continueLabel,
  canContinue = true,
}: {
  props: StepPanelProps;
  title: string;
  description: string;
  children?: ReactNode;
  onContinue: () => void;
  continueLabel?: string;
  canContinue?: boolean;
}) {
  const { t, busy, step } = props;
  return (
    <>
      <h2 id="tm-obw-step-title" className="tm-obw__title">
        {title}
      </h2>
      <p className="tm-obw__desc">{description}</p>
      {children ? <div className="tm-obw__content">{children}</div> : null}
      <div className="tm-obw__actions">
        {step !== 'company' ? (
          <OutlineButton onClick={props.onBack} disabled={busy}>
            {t('back', 'Back')}
          </OutlineButton>
        ) : null}
        <span className="tm-obw__spacer" />
        {step !== 'finish' ? (
          <OutlineButton onClick={() => props.onRecord('skipped')} disabled={busy}>
            {t('skipStep', 'Skip this step')}
          </OutlineButton>
        ) : null}
        <LimeButton onClick={onContinue} disabled={busy || !canContinue}>
          {continueLabel ?? t('continue', 'Continue')}
        </LimeButton>
      </div>
    </>
  );
}

function CompanyStep(props: StepPanelProps) {
  const { api, organizationSlug, t } = props;
  const profile = useQuery({
    queryKey: ['organization-profile', organizationSlug],
    queryFn: () => readOrganizationProfile(api, organizationSlug),
  });
  const [name, setName] = useState<string | null>(null);
  const [logo, setLogo] = useState<File | null>(null);
  const shown = name ?? profile.data?.name ?? '';
  return (
    <StepFrame
      props={props}
      title={t('company.title', 'Your company')}
      description={t('company.desc', 'The name and logo your team and clients will see.')}
      canContinue={shown.trim() !== ''}
      onContinue={() =>
        props.onRecord('done', async () => {
          if (name !== null && name.trim() !== profile.data?.name) {
            await renameOrganization(api, organizationSlug, name.trim());
          }
          if (logo) await uploadOrganizationLogoImage(api, organizationSlug, logo);
        })
      }
    >
      <Field
        label={t('company.name', 'Company name')}
        value={shown}
        onChange={(event) => setName(event.target.value)}
        required
      />
      <Field
        label={t('company.logo', 'Logo (optional)')}
        hint={t('company.logoHint', 'PNG, JPG, WebP or SVG, up to 512 KB.')}
        type="file"
        accept={LOGO_IMAGE_ACCEPT}
        onChange={(event) => setLogo(event.target.files?.[0] ?? null)}
      />
    </StepFrame>
  );
}

function WorkTypeStep(props: StepPanelProps) {
  const { api, organizationSlug, t } = props;
  const [choice, setChoice] = useState<string>(WORK_TYPES[0][0]);
  return (
    <StepFrame
      props={props}
      title={t('workType.title', 'What kind of work do you do?')}
      description={t('workType.desc', 'We set up your projects to match. You can change it later.')}
      onContinue={() =>
        props.onRecord('done', async () => {
          await setOrgSetting(api, organizationSlug, 'operating_template', choice);
        })
      }
    >
      <RadioGroup legend={t('workType.legend', 'Work type')}>
        {WORK_TYPES.map(([value, key, english]) => (
          <Radio
            key={value}
            value={value}
            label={t(key, english)}
            checked={choice === value}
            onChange={() => setChoice(value)}
          />
        ))}
      </RadioGroup>
    </StepFrame>
  );
}

function InviteStep(props: StepPanelProps) {
  const { api, organizationSlug, t } = props;
  const [text, setText] = useState('');
  const parsed = parseInviteEmails(text);
  return (
    <StepFrame
      props={props}
      title={t('invite.title', 'Invite your team')}
      description={t('invite.desc', 'Add the people you work with. They get an e-mail to join.')}
      canContinue={parsed.valid.length > 0 && parsed.invalid.length === 0}
      onContinue={() =>
        props.onRecord('done', async () => {
          for (const email of parsed.valid) {
            await issueInvitation(api, organizationSlug, {
              email,
              role: INVITABLE_ROLES[0] ?? 'member',
            });
          }
        })
      }
    >
      <Field
        label={t('invite.emails', 'E-mail addresses')}
        hint={t('invite.hint', 'Separate addresses with commas or new lines.')}
        error={
          parsed.invalid.length > 0
            ? t('invite.invalid', 'Check these addresses: {list}').replace(
                '{list}',
                parsed.invalid.join(', '),
              )
            : undefined
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </StepFrame>
  );
}

function StorageStep(props: StepPanelProps) {
  const { api, organizationSlug, t } = props;
  const drive = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
  });
  const oneDrive = useQuery({
    queryKey: ['onedrive-status', organizationSlug],
    queryFn: () => getOneDriveStatus(api, organizationSlug),
  });
  const connect = (start: () => Promise<{ readonly url: string }>) =>
    props.onRecord('done', async () => {
      const { url } = await start();
      props.onRedirect(url);
    });
  const options = [
    {
      key: 'drive',
      name: 'Google Drive',
      desc: t('storage.driveDesc', 'Files stay in your company Drive.'),
      configured: drive.data?.configured === true,
      connected: drive.data?.googleDrive.status === 'connected',
      start: () => startDriveConnect(api, organizationSlug, { returnTo: 'connected-apps' }),
    },
    {
      key: 'onedrive',
      name: 'OneDrive',
      desc: t('storage.oneDriveDesc', 'Files stay in your company OneDrive or SharePoint.'),
      configured: oneDrive.data?.configured === true,
      connected: oneDrive.data?.oneDrive.status === 'connected',
      start: () => startOneDriveConnect(api, organizationSlug, { returnTo: 'connected-apps' }),
    },
  ];
  return (
    <StepFrame
      props={props}
      title={t('storage.title', 'Connect your storage')}
      description={t(
        'storage.desc',
        'Keep project files in the Google Drive or OneDrive your company already uses. You can do this later in Settings.',
      )}
      onContinue={() => props.onRecord(options.some((o) => o.connected) ? 'done' : 'skipped')}
    >
      <ul className="tm-obw__options">
        {options.map((option) => (
          <li key={option.key} className="tm-obw__option">
            <span className="tm-obw__option-text">
              <strong>{option.name}</strong>
              <span>
                {option.configured
                  ? option.desc
                  : t('storage.unavailable', 'Not available on this workspace yet.')}
              </span>
            </span>
            {option.connected ? (
              <span className="tm-obw__connected">{t('storage.connected', 'Connected')}</span>
            ) : (
              <OutlineButton
                onClick={() => connect(option.start)}
                disabled={props.busy || !option.configured}
              >
                {t('storage.connect', 'Connect')}
              </OutlineButton>
            )}
          </li>
        ))}
      </ul>
    </StepFrame>
  );
}

function SampleProjectStep(props: StepPanelProps) {
  const { api, organizationSlug, t } = props;
  const packs = useQuery({
    queryKey: ['template-packs', organizationSlug],
    queryFn: () => listTemplatePacks(api, organizationSlug),
  });
  const [choice, setChoice] = useState<string | null>(null);
  const [role, setRole] = useState<PackRole | null>(null);
  const locale = useActiveLocale();
  const tOr = useTOr();
  const tPack = (key: string, field: 'name' | 'description', fallback: string) =>
    tOr(`TemplatePacks.pack.${key}.${field}`, fallback);
  const shown = filterTemplatePacks(packs.data ?? [], role, locale);
  const selected = shown.find((pack) => pack.key === choice) ?? shown[0];
  return (
    <StepFrame
      props={props}
      title={t('sample.title', 'Start with a sample project')}
      description={t(
        'sample.descByRole',
        'Pick your role, then a starter pack. We create one project from it so you can look around.',
      )}
      continueLabel={t('sample.create', 'Create sample project')}
      canContinue={selected !== undefined}
      onContinue={() =>
        props.onRecord('done', async () => {
          if (!selected) return;
          await installTemplatePack(api, organizationSlug, selected.key);
          const [templates, workspaces] = await Promise.all([
            listProjectTemplates(api, organizationSlug),
            listWorkspaces(api, organizationSlug),
          ]);
          const template = templates.find((entry) => entry.name === selected.templateNames[0]);
          const workspaceId = workspaces[0]?.id;
          if (template && workspaceId) {
            await instantiateProjectTemplate(api, organizationSlug, template.id, { workspaceId });
          }
        })
      }
    >
      {packs.isError ? (
        <InlineAlert tone="neutral">
          {t('sample.unavailable', 'Starter packs are not available right now. Skip this step.')}
        </InlineAlert>
      ) : (
        <>
          <p className="tm-obw__label">{t('sample.roleLegend', 'Your role')}</p>
          <PackRoleFilter
            value={role}
            onChange={setRole}
            label={t('sample.roleLegend', 'Your role')}
          />
          <RadioGroup legend={t('sample.legend', 'Starter pack')}>
            {shown.map((pack) => (
              <Radio
                key={pack.key}
                value={pack.key}
                label={
                  pack.language === 'ar'
                    ? `${tPack(pack.key, 'name', pack.name)} · ${tOr('TemplatePacks.arabic', 'Arabic')}`
                    : tPack(pack.key, 'name', pack.name)
                }
                hint={tPack(pack.key, 'description', pack.description)}
                checked={selected?.key === pack.key}
                onChange={() => setChoice(pack.key)}
              />
            ))}
          </RadioGroup>
        </>
      )}
    </StepFrame>
  );
}

function FinishStep(props: StepPanelProps) {
  const { t } = props;
  return (
    <StepFrame
      props={props}
      title={t('finish.title', 'You are all set')}
      description={t('finish.desc', 'Your workspace is ready. My Day shows what needs you today.')}
      continueLabel={t('finish.go', 'Go to My Day')}
      onContinue={() => props.onRecord('done')}
    />
  );
}

/** Ported from the R48 L1 Figma section (node 589:33299); logical properties so Arabic mirrors. */
const WIZARD_CSS = `
.tm-obw { min-block-size: 100vh; display: flex; flex-direction: column; gap: 32px; padding: 32px 40px; background: var(--paper-50); color: var(--ink-950); }
.tm-obw__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.tm-obw__brand { font-size: 18px; font-weight: 700; }
.tm-obw__body { display: flex; align-items: flex-start; gap: 32px; }
.tm-obw__rail { flex: 0 0 280px; display: flex; flex-direction: column; gap: 8px; }
.tm-obw__rail-title { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; }
.tm-obw__rail-sub { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-500); }
.tm-obw__steps { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 16px 0 0; list-style: none; }
.tm-obw__step { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: var(--b-quiet) solid transparent; border-radius: var(--r-control); font-size: var(--t-ui-md); color: var(--ink-650); }
.tm-obw__step[data-state='done'] { color: var(--ink-950); }
.tm-obw__step[data-state='current'] { color: var(--ink-950); font-weight: 600; background: var(--paper-0); border-color: var(--line-300); }
.tm-obw__marker { flex-shrink: 0; display: grid; place-items: center; inline-size: 24px; block-size: 24px; border-radius: var(--r-capsule); background: var(--paper-150); font-size: 12px; font-weight: 700; color: var(--ink-650); }
.tm-obw__step[data-state='done'] .tm-obw__marker { background: var(--success-600); color: var(--tm-paper-absolute); }
.tm-obw__step[data-state='current'] .tm-obw__marker { background: var(--lime-500); color: var(--tm-on-lime); }
.tm-obw__panel { flex: 1 1 auto; min-inline-size: 0; display: flex; flex-direction: column; gap: 16px; padding: 32px; background: var(--paper-0); border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-card); }
.tm-obw__eyebrow { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-500); }
.tm-obw__title { margin: 0; font-size: 28px; line-height: 34px; font-weight: 700; }
.tm-obw__desc { margin: 0; font-size: 15px; line-height: 22px; color: var(--ink-650); }
.tm-obw__label { margin: 0; font-size: var(--t-ui-md); font-weight: 600; color: var(--ink-950); }
.tm-obw__content { display: flex; flex-direction: column; gap: 12px; padding-block-start: 8px; }
.tm-obw__options { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.tm-obw__option { display: flex; align-items: center; gap: 16px; padding: 16px 20px; background: var(--paper-0); border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-control); }
.tm-obw__option-text { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; font-size: var(--t-caption); color: var(--ink-650); }
.tm-obw__option-text strong { font-size: 15px; color: var(--ink-950); }
.tm-obw__connected { font-size: var(--t-caption); font-weight: 600; color: var(--success-600); }
.tm-obw__actions { display: flex; align-items: center; gap: 12px; padding-block-start: 16px; }
.tm-obw__spacer { flex: 1 1 auto; }
@media (max-width: 760px) {
  .tm-obw { padding: 20px 16px; }
  .tm-obw__body { flex-direction: column; }
  .tm-obw__rail { flex-basis: auto; inline-size: 100%; }
}
`;
