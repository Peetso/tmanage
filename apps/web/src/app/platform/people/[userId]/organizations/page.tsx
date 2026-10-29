'use client';

import { use } from 'react';
import { PersonOrganizationsScreen } from '../../../../../components/platform/people/PersonOrganizationsScreen';

/** Platform admin — B4 one person's organizations and permissions (platform-admin v2 · PA-06). */
export default function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  return <PersonOrganizationsScreen userId={userId} />;
}
