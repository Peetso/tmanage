'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { getAiEmployee, type AiEmployeeView } from '../../lib/api/ai-employees';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { fill } from '../people/ChangeRoleDialog';
import { TestMark } from './ai-icons';
import { TEST_POLL_MS, clock, testFacts, testState, type TestState } from './ai-employee-model';

/**
 * S4 Test (Figma `952:2774` waiting, `952:3304` ready, `952:3842` not called), built on what Phase 1
 * can prove. There is no sample task yet (that is Phase 3), so the checklist shows the two facts
 * the server already records: a credential works as him (`connection.live > 0`) and his agent has
 * called TManage (`connection.lastCalledAt` after he was hired).
 *
 * While the step is open it re-reads him every few seconds, for two minutes at most; then it stops
 * and says he has not called. "Check again" starts one more window. Closing the step stops it.
 */
export function TestPanel({
  api,
  organizationSlug,
  ai,
  onState,
  onChangeConnection,
  now = Date.now,
  initialElapsedMs = 0,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly ai: AiEmployeeView;
  /** Tells the wizard whether he is ready (the close confirm and Done depend on it). */
  readonly onState: (state: TestState) => void;
  readonly onChangeConnection: () => void;
  /** Tests and stories: a fixed clock. */
  readonly now?: () => number;
  /** Stories: open as if this long had passed (S4c "0:48", S4e). */
  readonly initialElapsedMs?: number;
}) {
  const tOr = useTOr();
  const [windowStart, setWindowStart] = useState(() => now() - initialElapsedMs);
  const [elapsed, setElapsed] = useState(initialElapsedMs);
  const since = Date.parse(ai.createdAt);

  const latest = useQuery({
    queryKey: ['ai-employees', organizationSlug, 'test', ai.id],
    queryFn: () => getAiEmployee(api, organizationSlug, ai.id),
    initialData: ai,
    retry: false,
    refetchInterval: (query) => {
      const current = query.state.data ?? ai;
      const state = testState(testFacts(current, since), now() - windowStart);
      return state === 'waiting' ? TEST_POLL_MS : false;
    },
  });
  const facts = testFacts(latest.data ?? ai, since);
  const state = testState(facts, elapsed);

  useEffect(() => {
    if (state !== 'waiting') return undefined;
    const timer = window.setInterval(() => setElapsed(now() - windowStart), 1_000);
    return () => window.clearInterval(timer);
  }, [state, windowStart, now]);

  useEffect(() => onState(state), [state, onState]);

  const name = ai.displayName;
  const rows = [
    {
      key: 'connects',
      label: tOr('AiTest.connects', 'Connects to TManage'),
      done: facts.connected,
    },
    { key: 'calls', label: tOr('AiTest.calls', 'Calls TManage'), done: facts.called },
  ];
  const firstOpen = rows.findIndex((row) => !row.done);

  return (
    <div className="tm-aie-test">
      <p className="tm-team-dialog__body">
        {fill(tOr('AiTest.intro', 'Start {name}’s agent. This checks that it reaches TManage.'), {
          name,
        })}
      </p>
      <ul className="tm-aie-test__list" aria-label={tOr('AiTest.checklist', 'Connection check')}>
        {rows.map((row, index) => {
          const mark = row.done
            ? 'done'
            : state === 'waiting' && index === firstOpen
              ? 'waiting'
              : 'todo';
          return (
            <li key={row.key} className="tm-aie-test__row">
              <TestMark state={mark} />
              <span className="tm-aie-test__label">{row.label}</span>
              <span className="tm-aie-test__state">
                {mark === 'done'
                  ? tOr('AiTest.done', 'Done')
                  : mark === 'waiting'
                    ? tOr('AiTest.waiting', 'Waiting…')
                    : tOr('AiTest.notYet', 'Not yet')}
              </span>
            </li>
          );
        })}
      </ul>

      {state === 'waiting' ? (
        <p className="tm-aie-quiet" role="status">
          {fill(tOr('AiTest.waitingFor', 'Waiting for {name} · {time}'), {
            name,
            time: clock(elapsed),
          })}
        </p>
      ) : null}

      {state === 'ready' ? (
        <InlineAlert tone="success" live>
          {fill(tOr('AiTest.ready', '{name} is ready for work.'), { name })}
        </InlineAlert>
      ) : null}

      {state === 'notCalled' ? (
        <>
          <InlineAlert tone="warning" live>
            {fill(
              tOr(
                'AiTest.notCalled',
                '{name} has not called yet. Check that your agent is running and has the address.',
              ),
              { name },
            )}
          </InlineAlert>
          <div className="tm-aie-row">
            <Button
              type="button"
              tone="outline"
              size="header"
              onClick={() => {
                const start = now();
                setWindowStart(start);
                setElapsed(0);
                void latest.refetch();
              }}
            >
              {tOr('AiTest.checkAgain', 'Check again')}
            </Button>
            <Button type="button" tone="text" size="header" onClick={onChangeConnection}>
              {tOr('AiTest.changeConnection', 'Change connection')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
