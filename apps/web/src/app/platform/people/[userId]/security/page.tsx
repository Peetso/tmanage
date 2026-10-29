'use client';

import { use } from 'react';
import { PersonSecurityScreen } from '../../../../../components/platform/people/PersonSecurityScreen';

/** Platform admin — B3 one person's security and sessions (platform-admin v2 · PA-06). */
export default function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <PersonSecurityScreen userId={userId} />;
}
