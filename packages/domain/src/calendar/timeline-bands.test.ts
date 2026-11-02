import { describe, expect, it } from 'vitest';
import { clientStatusOf, milestoneMarkers, orderMilestones, phaseBands } from './timeline-bands.js';
import type { TimelineMilestoneInput, TimelinePhaseInput } from './timeline-bands.js';

const TODAY = '2026-11-02';

function milestone(overrides: Partial<TimelineMilestoneInput>): TimelineMilestoneInput {
  return {
    id: 'm1',
    title: 'Launch',
    status: 'planned',
    dueOn: null,
    committedOn: null,
    forecastOn: null,
    timelineOrder: null,
    phaseId: null,
    ...overrides,
  };
}

function phase(overrides: Partial<TimelinePhaseInput>): TimelinePhaseInput {
  return {
    id: 'p1',
    name: 'Design',
    position: 0,
    startsOn: null,
    endsOn: null,
    colorToken: null,
    ...overrides,
  };
}

describe('53-07 timeline bands', () => {
  it('uses explicit phase dates, else the span of its assigned milestones, else no band', () => {
    const bands = phaseBands(
      [
        phase({ id: 'p2', position: 1 }),
        phase({ id: 'p1', position: 0, startsOn: '2026-01-01', endsOn: '2026-02-01' }),
        phase({ id: 'p3', position: 2 }),
      ],
      [
        milestone({ id: 'a', phaseId: 'p2', dueOn: '2026-05-10' }),
        milestone({ id: 'b', phaseId: 'p2', committedOn: '2026-03-01', dueOn: '2026-09-09' }),
        milestone({ id: 'c', phaseId: 'p1', dueOn: '2027-01-01' }),
      ],
    );
    expect(bands.map((band) => [band.id, band.startsOn, band.endsOn, band.source])).toEqual([
      ['p1', '2026-01-01', '2026-02-01', 'explicit'],
      ['p2', '2026-03-01', '2026-05-10', 'derived'],
      ['p3', null, null, 'none'],
    ]);
  });

  it('places the diamond on committed, then forecast, then due, and reads health from dates', () => {
    const markers = milestoneMarkers(
      [
        milestone({
          id: 'c',
          committedOn: '2026-12-01',
          forecastOn: '2026-12-05',
          dueOn: '2026-11-30',
        }),
        milestone({ id: 'f', forecastOn: '2026-12-10', dueOn: '2026-11-30' }),
        milestone({ id: 'd', dueOn: '2026-11-30' }),
        milestone({ id: 'late', committedOn: '2026-10-01' }),
        milestone({ id: 'met', committedOn: '2026-10-01', status: 'met' }),
      ],
      TODAY,
    );
    expect(markers.map((marker) => [marker.id, marker.date, marker.health])).toEqual([
      ['c', '2026-12-01', 'at_risk'],
      ['f', '2026-12-10', 'on_track'],
      ['d', '2026-11-30', 'on_track'],
      ['late', '2026-10-01', 'at_risk'],
      ['met', '2026-10-01', 'done'],
    ]);
    expect(clientStatusOf(milestone({ committedOn: '2027-01-01' }), TODAY)).toBe('on_track');
  });

  it('orders by timeline order, then date, then title', () => {
    const ordered = orderMilestones([
      milestone({ id: 'x', title: 'B', dueOn: '2026-01-01' }),
      milestone({ id: 'y', title: 'A', dueOn: '2026-01-01' }),
      milestone({ id: 'z', title: 'Z', timelineOrder: 1 }),
      milestone({ id: 'w', title: 'W' }),
    ]);
    expect(ordered.map((row) => row.id)).toEqual(['z', 'y', 'x', 'w']);
  });
});
