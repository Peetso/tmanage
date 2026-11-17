/**
 * 57-13r / 57-19 copy, namespace `planStorage`: the temporary storage allowance on the "Where your
 * files live" card and the automation runs counter on Plan and usage. The English default beside
 * every key; the catalogs carry the same keys. `{slot}` is filled by the component.
 */
export const PLAN_STORAGE_COPY = {
  'planStorage.label': 'Temporary storage on TManage',
  'planStorage.value': '{used} of {limit}',
  'planStorage.valueText':
    '{percent}% of the temporary storage on TManage is in use: {used} of {limit}',
  'planStorage.help':
    'Files stay on TManage only until you connect Google Drive or OneDrive. This space is a temporary allowance: it is never sold and never needs a bigger plan.',
  'planStorage.raised': 'Raised for you by TManage support',
  'planStorage.noSetLimit': 'No set limit',
  'planStorage.valueNoLimit': '{used} · No set limit',
  'planStorage.notice70':
    '{percent}% of your temporary storage is used. Connect Google Drive or OneDrive so new files go there.',
  'planStorage.notice85':
    '{percent}% of your temporary storage is used. Connect Google Drive or OneDrive soon so uploads keep working.',
  'planStorage.notice95':
    'Your temporary storage is almost full ({percent}%). Connect Google Drive or OneDrive now.',
  'planStorage.notice100':
    'Your temporary storage is full. New uploads wait until you connect Google Drive or OneDrive, or move files there. Nothing is deleted.',
  'planStorage.runsLabel': 'Automation runs this period',
  'planStorage.runsBadge': 'No limit',
  'planStorage.runsNote':
    'Shown for your information. Automations are unlimited on every plan and are never stopped because of your plan.',
} as const;

export type PlanStorageCopyKey = keyof typeof PLAN_STORAGE_COPY;

export type PlanStorageText = (key: PlanStorageCopyKey) => string;

export function planStorageText(tOr: (key: string, english: string) => string): PlanStorageText {
  return (key) => tOr(key, PLAN_STORAGE_COPY[key]);
}
