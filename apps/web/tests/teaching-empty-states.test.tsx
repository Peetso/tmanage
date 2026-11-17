import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChecklistTemplatesView } from '../src/components/screens/ChecklistTemplatesView';
import { ClientsScreen } from '../src/components/screens/ClientsScreen';
import { ConversationSearchView } from '../src/components/screens/ConversationSearchView';
import { DecisionRegisterScreen } from '../src/components/screens/DecisionRegisterScreen';
import { DocsHubScreen } from '../src/components/screens/DocsHubScreen';
import { AdminExportRequestsScreen } from '../src/components/screens/AdminExportRequestsScreen';
import { AdminInvitationsView } from '../src/components/screens/AdminInvitationsView';
import { AdminRolesScreen } from '../src/components/screens/AdminRolesScreen';
import { AutomationRunHistoryScreen } from '../src/components/screens/AutomationRunHistoryScreen';
import { AutomationSchedulesScreen } from '../src/components/screens/AutomationSchedulesScreen';
import { AutomationTemplatesScreen } from '../src/components/screens/AutomationTemplatesScreen';
import { DocCollectionsScreen } from '../src/components/screens/DocCollectionsScreen';
import { DocumentTemplatesScreen } from '../src/components/screens/DocumentTemplatesScreen';
import { FilesHubScreen } from '../src/components/screens/FilesHubScreen';
import { FocusBlocksScreen } from '../src/components/screens/FocusBlocksScreen';
import { GlossaryScreen } from '../src/components/screens/GlossaryScreen';
import { InsightCustomReportsView } from '../src/components/screens/InsightCustomReportsView';
import { InsightMetricAlertsScreen } from '../src/components/screens/InsightMetricAlertsScreen';
import { InsightSnapshotsScreen } from '../src/components/screens/InsightSnapshotsScreen';
import { MeetingActionItemsScreen } from '../src/components/screens/MeetingActionItemsScreen';
import { MeetingSeriesScreen } from '../src/components/screens/MeetingSeriesScreen';
import { MyBookmarksScreen } from '../src/components/screens/MyBookmarksScreen';
import { NotificationsFeedScreen } from '../src/components/screens/NotificationsFeedScreen';
import { OrgAnnouncementsView } from '../src/components/screens/OrgAnnouncementsView';
import { OrgObjectivesScreen } from '../src/components/screens/OrgObjectivesScreen';
import { ReportSchedulesScreen } from '../src/components/screens/ReportSchedulesScreen';
import { RequestInboxScreen } from '../src/components/screens/RequestInboxScreen';
import { SavedMessagesScreen } from '../src/components/screens/SavedMessagesScreen';
import { SavedInsightViewsScreen } from '../src/components/screens/SavedInsightViewsScreen';
import { SavedSearchesScreen } from '../src/components/screens/SavedSearchesScreen';
import { TeamsScreen } from '../src/components/screens/TeamsScreen';
import { WebhookEndpointsScreen } from '../src/components/screens/WebhookEndpointsScreen';
import { WorkLabelsScreen } from '../src/components/screens/WorkLabelsScreen';
import { WorkCalendarScreen } from '../src/components/screens/WorkCalendarScreen';
import { PortalMilestonesScreen } from '../src/components/screens/PortalMilestonesScreen';
import { PortalPeopleScreen } from '../src/components/screens/PortalPeopleScreen';
import { PortalRisksScreen } from '../src/components/screens/PortalRisksScreen';
import { PortalUpdatesScreen } from '../src/components/screens/PortalUpdatesScreen';
import { InboxSavedFiltersScreen } from '../src/components/screens/InboxSavedFiltersScreen';
import { InboxScreen } from '../src/components/screens/InboxScreen';
import { ApiClient } from '../src/lib/api/client';
import { translate } from '../src/lib/i18n/t';

/** 55-10p: a truly empty list teaches with one action; a list with rows, or a filter, does not. */
type Routes = Record<string, unknown>;

function mount(screenFor: (client: ApiClient) => ReactElement, routes: Routes, role = 'owner') {
  const answer = (path: string) =>
    Object.entries(routes)
      .filter(([suffix]) => path.endsWith(suffix))
      .sort(([a], [b]) => b.length - a.length)[0]?.[1];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const body = answer(new URL(String(input)).pathname);
      return Promise.resolve(
        new Response(JSON.stringify(body ?? {}), {
          status: body ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The shell reads the role through its own browser client; seed it as an owner.
  // A custom role with no capabilities stands for a person without the permission.
  query.setQueryData(['shell', 'organizations'], [{ slug: 'acme', role, capabilities: [] }]);
  render(<QueryClientProvider client={query}>{screenFor(client)}</QueryClientProvider>);
}

const teaching = (title: RegExp) => screen.findByRole('heading', { level: 2, name: title });

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('teaching empty states (55-10p)', () => {
  it('Inbox: the empty All list teaches with Invite your team; an empty filter does not', async () => {
    const inbox = (client: ApiClient) => (
      <InboxScreen organizationSlug="acme" organizationName="Acme" client={client} />
    );
    mount(inbox, { '/inbox': { items: [], nextCursor: null } });
    await teaching(/your inbox is ready/i);
    expect(screen.getByRole('link', { name: /invite your team/i }).getAttribute('href')).toBe(
      '/acme/people',
    );
    cleanup();
    window.history.replaceState(null, '', '/?mode=waiting_on_me');
    mount(inbox, { '/inbox': { items: [], nextCursor: null } });
    await screen.findByText(translate('en-US', 'InboxScreen.emptyTitleWaiting'));
    expect(screen.queryByRole('heading', { name: /your inbox is ready/i })).toBeNull();
  });

  it('Docs: an empty Recent teaches with New doc; a doc on the list hides it', async () => {
    const docs = (client: ApiClient) => (
      <DocsHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
    );
    mount(docs, { '/recent-documents': { documents: [], hiddenCount: 0 } });
    await teaching(/no documents yet/i);
    expect(screen.getAllByRole('button', { name: /new doc/i })).toHaveLength(2);
    cleanup();
    mount(docs, {
      '/recent-documents': {
        documents: [
          {
            id: 'd1',
            title: 'Brief',
            projectName: 'P',
            audience: 'internal',
            clientAudienceCount: 0,
            updatedAt: '2026-11-01T00:00:00Z',
          },
        ],
        hiddenCount: 0,
      },
    });
    await screen.findByRole('link', { name: 'Brief' });
    expect(screen.queryByRole('heading', { name: /no documents yet/i })).toBeNull();
  });

  it('Clients: no company teaches with Invite client; a company hides it', async () => {
    const clients = (client: ApiClient) => (
      <ClientsScreen organizationSlug="acme" organizationName="Acme" client={client} />
    );
    mount(clients, { '/client-organizations': { clientOrganizations: [] } });
    await teaching(/no clients yet/i);
    expect(screen.getAllByRole('button', { name: /invite client/i })).toHaveLength(2);
    cleanup();
    mount(clients, {
      '/client-organizations': {
        clientOrganizations: [
          { id: 'co', name: 'Atlas', createdAt: '', updatedAt: '', archivedAt: null },
        ],
      },
    });
    await screen.findByText('Atlas');
    expect(screen.queryByRole('heading', { name: /no clients yet/i })).toBeNull();
  });

  it('Decisions: an empty register teaches with Record a decision, which focuses the form', async () => {
    const decisions = (client: ApiClient) => (
      <DecisionRegisterScreen
        organizationSlug="acme"
        organizationName="Acme"
        initialProjectId="p1"
        client={client}
      />
    );
    const projects = { '/projects': { projects: [{ id: 'p1', name: 'North' }] } };
    mount(decisions, { ...projects, '/decisions': { decisions: [] } });
    await teaching(/no decisions yet/i);
    (await screen.findByRole('button', { name: /record a decision/i })).click();
    expect(document.activeElement?.getAttribute('name')).toBe('title');
    cleanup();
    mount(decisions, {
      ...projects,
      '/decisions': {
        decisions: [
          {
            id: 'd',
            projectId: 'p1',
            meetingId: null,
            title: 'Go',
            statement: 's',
            status: 'accepted',
            decidedBy: 'u',
            decidedAt: '2026-01-01T00:00:00Z',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });
    await screen.findByRole('rowheader', { name: /go/i });
    expect(screen.queryByRole('heading', { name: /no decisions yet/i })).toBeNull();
  });

  it('Files: an empty All projects teaches with Upload files; one chosen project does not', async () => {
    const routes = {
      '/projects': { projects: [{ id: 'p1', name: 'Site' }] },
      '/projects/p1/files': { files: [] },
    };
    mount(
      (client) => (
        <FilesHubScreen organizationSlug="acme" organizationName="Acme" client={client} />
      ),
      routes,
    );
    const section = (await teaching(/no files yet/i)).closest('section') as HTMLElement;
    expect(section.querySelector('button')?.textContent).toBe('Upload files');
    expect(section.querySelector('a')?.getAttribute('data-help-slug')).toBe(
      'upload-and-share-files',
    );
    cleanup();
    mount(
      (client) => (
        <FilesHubScreen
          organizationSlug="acme"
          organizationName="Acme"
          initialProjectId="p1"
          client={client}
        />
      ),
      routes,
    );
    await screen.findByText('No files yet');
    expect(screen.queryByRole('heading', { name: /no files yet/i })).toBeNull();
  });

  describe('client portal: teaches with no team-only action', () => {
    const portal = {
      '/portal/projects': { projects: [{ id: 'p1', name: 'Site' }] },
      '/portal/projects/p1/updates': { updates: [] },
      '/portal/projects/p1/milestones': { milestones: [] },
      '/portal/projects/p1/risks': { risks: [] },
      '/portal/projects/p1/people': { people: [] },
    };
    const props = { organizationSlug: 'acme', clientName: 'Bloom', providerName: 'Acme' };
    const cases: readonly [string, (client: ApiClient) => ReactElement, RegExp][] = [
      [
        'Updates',
        (client) => <PortalUpdatesScreen {...props} client={client} />,
        /no updates yet/i,
      ],
      ['Risks', (client) => <PortalRisksScreen {...props} client={client} />, /no risks flagged/i],
      [
        'Timeline',
        (client) => <PortalMilestonesScreen {...props} client={client} />,
        /no milestones yet/i,
      ],
      [
        'People',
        (client) => <PortalPeopleScreen {...props} client={client} />,
        /no contacts shared yet/i,
      ],
    ];
    it.each(cases)('%s', async (_name, view, title) => {
      mount(view, portal);
      const section = (await teaching(title)).closest('section') as HTMLElement;
      expect(section.textContent).toContain('Acme');
      expect(section.querySelector('button, a')).toBeNull();
    });
  });

  describe('team screens: the action needs the permission', () => {
    const routes = {
      '/automations/templates': { templates: [] },
      '/automations/schedules': { schedules: [] },
      '/automations/runs': { runs: [] },
      '/documents/templates': { templates: [] },
      '/insights/report-schedules': { schedules: [] },
      '/insights/custom-reports': { reports: [] },
      '/projects': { projects: [] },
      '/glossary/terms': { terms: [] },
      '/calendar/focus-blocks': { blocks: [] },
      '/doc-collections': { collections: [] },
      '/meetings/m1/action-items': { actionItems: [] },
      '/search/saved': { savedSearches: [] },
      '/admin/roles': { roles: [] },
      '/admin/export-requests': { requests: [] },
      '/inbox/saved-filters': { savedFilters: [] },
      '/work/checklist-templates': { templates: [] },
      '/work/labels': { labels: [] },
      '/message-bookmarks': { messages: [] },
      '/document-bookmarks': { bookmarks: [] },
      '/insights/saved-views': { savedViews: [] },
      '/insights/snapshots': [],
      '/insights/metric-alerts': { alerts: [] },
      '/notifications': { items: [], nextCursor: null },
      '/objectives': { objectives: [] },
      '/meeting-series': { series: [] },
      '/automations/webhooks': { endpoints: [] },
      '/announcements': { announcements: [] },
      '/client-requests': { clientRequests: [] },
      '/people/teams': { teams: [] },
    };
    const props = { organizationSlug: 'acme', organizationName: 'Acme' };
    const cases: readonly [string, (client: ApiClient) => ReactElement, RegExp, string][] = [
      [
        'Automations',
        (client) => <AutomationTemplatesScreen {...props} client={client} />,
        /no automations yet/i,
        'Create an automation',
      ],
      [
        'Automation schedules',
        (client) => <AutomationSchedulesScreen {...props} client={client} />,
        /no schedules yet/i,
        'Add a schedule',
      ],
      [
        'Document templates',
        (client) => <DocumentTemplatesScreen {...props} client={client} />,
        /no templates yet/i,
        'Create a template',
      ],
      [
        'Report schedules',
        (client) => <ReportSchedulesScreen {...props} client={client} />,
        /no schedules yet/i,
        'Schedule a report',
      ],
      [
        'Custom reports',
        (client) => <InsightCustomReportsView {...props} client={client} />,
        /no custom reports yet/i,
        'Build a report',
      ],
      [
        'Glossary',
        (client) => <GlossaryScreen {...props} client={client} />,
        /no terms/i,
        'Add a term',
      ],
      [
        'Focus blocks',
        (client) => <FocusBlocksScreen {...props} client={client} />,
        /no focus blocks/i,
        'Plan focus time',
      ],
      [
        'Doc collections',
        (client) => <DocCollectionsScreen {...props} client={client} />,
        /no collections yet/i,
        'Create a collection',
      ],
      [
        'Meeting action items',
        (client) => <MeetingActionItemsScreen {...props} meetingId="m1" client={client} />,
        /no action items yet/i,
        'Add an action item',
      ],
      [
        'Saved searches',
        (client) => <SavedSearchesScreen {...props} client={client} />,
        /no saved searches yet/i,
        'Save a search',
      ],
      [
        'Custom roles',
        (client) => <AdminRolesScreen {...props} client={client} />,
        /no custom roles yet/i,
        'Create a role',
      ],
      [
        'Export requests',
        (client) => <AdminExportRequestsScreen {...props} client={client} />,
        /no export requests yet/i,
        'Request an export',
      ],
      [
        'Inbox saved filters',
        (client) => <InboxSavedFiltersScreen {...props} client={client} />,
        /no saved filters yet/i,
        'Save a filter',
      ],
      [
        'Checklist templates',
        (client) => <ChecklistTemplatesView {...props} client={client} />,
        /no checklist templates yet/i,
        'Create a checklist',
      ],
      [
        'Work labels',
        (client) => <WorkLabelsScreen {...props} client={client} />,
        /no labels yet/i,
        'Create a label',
      ],
      [
        'Saved report views',
        (client) => <SavedInsightViewsScreen {...props} client={client} />,
        /no saved views yet/i,
        'Save a view',
      ],
      [
        'Objectives',
        (client) => <OrgObjectivesScreen {...props} client={client} />,
        /no objectives yet/i,
        'Set an objective',
      ],
      [
        'Meeting series',
        (client) => <MeetingSeriesScreen {...props} client={client} />,
        /no series yet/i,
        'Plan a repeating meeting',
      ],
      [
        'Webhooks',
        (client) => <WebhookEndpointsScreen {...props} client={client} />,
        /no endpoints yet/i,
        'Add a webhook',
      ],
      [
        'Announcements',
        (client) => <OrgAnnouncementsView {...props} client={client} />,
        /no active announcements/i,
        'Write an announcement',
      ],
    ];
    it.each(cases)('%s', async (_name, view, title, action) => {
      mount(view, routes);
      const section = (await teaching(title)).closest('section') as HTMLElement;
      const button = await within(section).findByRole('button', { name: action });
      fireEvent.click(button);
      expect(document.activeElement?.closest('form')).not.toBeNull();
      cleanup();
      mount(view, routes, 'custom-viewer');
      const bare = (await teaching(title)).closest('section') as HTMLElement;
      expect(within(bare).queryByRole('button')).toBeNull();
    });

    it('Invitations: Invite your team links to People, only with the right to invite', async () => {
      const invitations = (client: ApiClient) => (
        <AdminInvitationsView {...props} client={client} />
      );
      const withInvites = { ...routes, '/admin/invitations': { invitations: [] } };
      mount(invitations, withInvites);
      const section = (await teaching(/no pending invitations/i)).closest('section') as HTMLElement;
      expect(
        (await within(section).findByRole('link', { name: /invite your team/i })).getAttribute(
          'href',
        ),
      ).toBe('/acme/people');
      cleanup();
      mount(invitations, withInvites, 'custom-viewer');
      const bare = (await teaching(/no pending invitations/i)).closest('section') as HTMLElement;
      expect(within(bare).queryByRole('link', { name: /invite your team/i })).toBeNull();
    });

    it.each([
      ['Doc bookmarks', MyBookmarksScreen, /no bookmarks yet/i],
      ['Saved messages', SavedMessagesScreen, /no saved messages yet/i],
      ['Notifications', NotificationsFeedScreen, /nothing to catch up on/i],
      ['Report snapshots', InsightSnapshotsScreen, /no snapshots yet/i],
      ['Metric alerts', InsightMetricAlertsScreen, /no alerts yet/i],
      ['Teams', TeamsScreen, /no teams yet/i],
    ] as const)('%s: teaches, with nothing to start', async (_name, View, title) => {
      mount((client) => <View {...props} client={client} />, routes);
      const section = (await teaching(title)).closest('section') as HTMLElement;
      expect(within(section).queryByRole('button')).toBeNull();
    });

    it('Calendar: with no project, teaches with New project only for those who may create one', async () => {
      const calendar = (client: ApiClient) => <WorkCalendarScreen {...props} client={client} />;
      mount(calendar, routes);
      const section = (await teaching(/no project to show yet/i)).closest('section') as HTMLElement;
      expect(await within(section).findByRole('link', { name: /new project/i })).toBeTruthy();
      cleanup();
      mount(calendar, routes, 'custom-viewer');
      const bare = (await teaching(/no project to show yet/i)).closest('section') as HTMLElement;
      expect(within(bare).queryByRole('link', { name: /new project/i })).toBeNull();
    });

    it('Client requests: teaches with Invite client only for admins', async () => {
      const inbox = (client: ApiClient) => <RequestInboxScreen {...props} client={client} />;
      mount(inbox, routes);
      const section = (await screen.findByRole('link', { name: /invite client/i })).closest(
        'section',
      ) as HTMLElement;
      expect(section.querySelector('h2')).not.toBeNull();
      cleanup();
      mount(inbox, routes, 'custom-viewer');
      await screen.findByText(/the request lands here/i);
      expect(screen.queryByRole('link', { name: /invite client/i })).toBeNull();
    });

    it('Chat search: a search with no match teaches how to search', async () => {
      mount((client) => <ConversationSearchView {...props} conversationId="c1" client={client} />, {
        '/conversations/c1': { id: 'c1', title: 'General' },
        '/conversations/c1/messages/search': { results: [] },
      });
      const field = await screen.findByRole('searchbox');
      fireEvent.change(field, { target: { value: 'invoice' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await teaching(/no messages match that search/i);
      expect(screen.getByText(/try fewer words/i)).toBeTruthy();
    });

    it('Automation runs: teaches, with nothing to start', async () => {
      mount((client) => <AutomationRunHistoryScreen {...props} client={client} />, routes);
      const section = (await teaching(/no runs yet/i)).closest('section') as HTMLElement;
      expect(within(section).queryByRole('button')).toBeNull();
    });
  });
});
