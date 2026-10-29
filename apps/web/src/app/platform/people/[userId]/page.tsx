'use client';

import { use } from 'react';
import { PersonProfileScreen } from '../../../../components/platform/people/PersonProfileScreen';

/** Platform admin — B2 one person's profile (platform-admin v2 · PA-06). */
export default function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <PersonProfileScreen userId={userId} />;
}
