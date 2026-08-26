import { InviteTeamScreen } from '../../../components/screens/InviteTeamScreen';
import {
  FIXTURE_EXISTING_MEMBERS,
  FIXTURE_ORGANIZATION_DOMAIN,
  FIXTURE_SIGNED_IN_AS,
} from '../../../lib/fixtures';

/** **ON-04 Invite internal team.** */
export default function InviteTeamPage() {
  return (
    <InviteTeamScreen
      signedInAs={FIXTURE_SIGNED_IN_AS}
      organizationDomain={FIXTURE_ORGANIZATION_DOMAIN}
      existingMembers={FIXTURE_EXISTING_MEMBERS}
    />
  );
}
