'use client';

import { useState } from 'react';
import { Button } from '@tmanage/ui';
import { useT } from '../../../lib/i18n/use-t';
import { usePlatformPermissions } from '../shared/usePlatformPermissions';
import { SupportSessionEnterDialog } from './SupportSessionEnterDialog';

/**
 * The lime "Enter in Support mode" button on the organization header (A3) and list (A2). Hidden
 * without `platform.orgs.enter`; disabled for a suspended organization (the API answers 409).
 */
export function SupportModeEntry({
  organizationId,
  organizationName,
  status,
}: {
  organizationId: string;
  organizationName: string;
  status: string;
}) {
  const t = useT();
  const permissions = usePlatformPermissions();
  const [open, setOpen] = useState(false);
  if (!permissions.has('platform.orgs.enter')) return null;
  const suspended = status === 'suspended';
  return (
    <>
      <Button
        type="button"
        tone="lime"
        onClick={() => setOpen(true)}
        disabled={suspended}
        {...(suspended ? { title: t('SupportMode.suspendedHint') } : {})}
      >
        {t('SupportMode.entryButton')}
      </Button>
      {open ? (
        <SupportSessionEnterDialog
          organizationId={organizationId}
          organizationName={organizationName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
