'use client';

import { SignUpScreen } from './SignUpScreen';
import { importPagePath, importToolFromSearch } from '../../lib/import-link';
import { afterSignUpPath } from '../../lib/api/plan-versions';

/**
 * 54-29 — `/sign-up` as reached from a "switch from X" page (`/sign-up?import=<tool>`).
 *
 * The screen is the ordinary sign-up; only where it leaves to changes. With an allowed tool in the
 * query the new workspace opens on its Import page with that tool chosen; with none (or a value
 * outside the allow-list) it opens on its home, exactly as before. The slug comes from the API's
 * answer and is encoded; the query only ever contributes an allow-listed id.
 */
export function SignUpWithImport({
  navigate = (href: string) => window.location.assign(href),
}: {
  navigate?: (href: string) => void;
}) {
  return (
    <SignUpScreen
      onCompleted={(organizationSlug, planId) => {
        const tool = importToolFromSearch(window.location.search);
        navigate(
          tool === undefined
            ? afterSignUpPath(organizationSlug, planId)
            : importPagePath(organizationSlug, tool),
        );
      }}
    />
  );
}
