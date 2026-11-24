import type { Decorator } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The shell reads the person's role through its own browser client, which has no API in
 * Storybook; seed it as an owner, so the page draws its write controls and the Control Center
 * menu draws the entries an owner sees (Work setup › Stages, marked on the Stages page).
 */
export const asOwner: Decorator = (Story) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['shell', 'organizations'], [{ slug: 'northstar', role: 'owner' }]);
  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};
