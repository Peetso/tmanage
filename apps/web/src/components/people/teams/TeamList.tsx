'use client';

import type { TeamListRowView } from '../../../lib/api/people-teams';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { pluralPhrase } from '../../../lib/i18n/plural';
import { withNumerals } from '../../../lib/i18n/display-format';
import { ForwardIcon } from '../../work/work-icons';
import { faceInitials } from './teams-model';

/**
 * **The team list** (Figma `WV2-05`): each team by name with its first three faces and how many
 * people; the open one is pressed. On a phone each row also says "5 people" under the name and
 * ends in a chevron, and opens the team as its own page. The screen keeps `?team=<id>` in the
 * address, so a team can be shared, reloaded and reached with Back.
 */
export function TeamList({
  teams,
  selectedId,
  onChoose,
}: {
  teams: readonly TeamListRowView[];
  selectedId: string | null;
  onChoose: (teamId: string) => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  return (
    <ul className="tm-team-list" aria-label={t('TeamsScreen.title')}>
      {teams.map((team) => (
        <li key={team.id}>
          <button
            type="button"
            className="tm-team-list__row"
            aria-pressed={team.id === selectedId}
            onClick={() => onChoose(team.id)}
          >
            <span className="tm-team-list__text">
              <bdi className="tm-team-list__name">{team.name}</bdi>
              <span className="tm-team-list__sub">
                {pluralPhrase(tOr, locale, 'TeamsScreen.peopleCount', team.memberCount, {
                  one: '1 person',
                  other: '{count} people',
                })}
              </span>
            </span>
            <span className="tm-team-faces" aria-hidden="true">
              {team.faces.map((face) => (
                <span key={face.userId} className="tm-team-face">
                  {faceInitials(face.displayName)}
                </span>
              ))}
            </span>
            <span className="tm-team-list__count" aria-hidden="true">
              {team.memberCount.toLocaleString(withNumerals(locale))}
            </span>
            <span className="tm-team-list__chevron" aria-hidden="true">
              <ForwardIcon />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
