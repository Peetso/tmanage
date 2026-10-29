import type { Metadata } from 'next';
import { DataLocationPage } from '../../../../components/website/pages/data-location/DataLocationPage';

/**
 * **Where your data lives** — the public `/security/data-location` page (54-17): what lives
 * where, who processes it, the transfer notice, the subprocessor list and the region request.
 */
export const metadata: Metadata = {
  title: 'Where your data lives',
  description:
    'Exactly where TManage keeps your database, files, backups, email and logs today, and who processes each part.',
};

export default function DataLocationRoute() {
  return <DataLocationPage />;
}
