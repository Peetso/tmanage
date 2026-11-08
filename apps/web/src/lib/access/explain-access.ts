/**
 * 55-23 "Why can I (not) see this?" — the plain-language reasons behind one person's access to
 * one item, built on the client from what the screen already holds: the caller's membership
 * (`GET …/me`: kind, role, capabilities) and the item's sharing (its audience and project).
 *
 * The permission-explain API (`…/people/:membershipId/effective-permissions`) needs
 * `people.manage`, so an ordinary member cannot ask it about themselves; this summary uses only
 * facts the member is already allowed to read, and it never decides anything — the API does.
 */

export type ItemAudience = 'internal' | 'client_visible' | 'client_action_required';

export interface AccessFacts {
  readonly kind: 'internal' | 'client' | 'service';
  /** Already a person's word for the role ("Member"). */
  readonly roleLabel: string;
  readonly capabilities: readonly string[];
  readonly audience: ItemAudience;
  readonly projectName: string;
  readonly isOwner: boolean;
  /** The capability editing needs (`work.update`). */
  readonly editCapability: string;
  /** Its plain name ("Edit work"). */
  readonly editCapabilityLabel: string;
}

/** One sentence: a message key, its English and the values to fill in. */
export interface AccessReason {
  readonly key: string;
  readonly english: string;
  readonly vars?: Readonly<Record<string, string>>;
}

export interface AccessExplanation {
  readonly see: readonly AccessReason[];
  readonly canEdit: boolean;
  readonly edit: readonly AccessReason[];
}

export function explainAccess(facts: AccessFacts): AccessExplanation {
  const role: AccessReason = {
    key: 'AccessExplainer.role',
    english: 'Your role: {role}',
    vars: { role: facts.roleLabel },
  };
  const see: AccessReason[] = [role];

  if (facts.kind === 'client') {
    see.push({
      key: 'AccessExplainer.clientShared',
      english: 'Your company was given this item through the project {project}',
      vars: { project: facts.projectName },
    });
  } else {
    if (facts.isOwner) {
      see.push({ key: 'AccessExplainer.owner', english: 'You own this item' });
    }
    see.push({
      key: 'AccessExplainer.project',
      english: 'It belongs to the project {project}, which your role can open',
      vars: { project: facts.projectName },
    });
  }

  see.push(audienceReason(facts.audience));

  const canEdit = facts.capabilities.includes(facts.editCapability);
  const edit: AccessReason[] = canEdit
    ? [
        role,
        {
          key: 'AccessExplainer.canEdit',
          english: 'Your role includes “{permission}”',
          vars: { permission: facts.editCapabilityLabel },
        },
      ]
    : [
        role,
        {
          key: 'AccessExplainer.cannotEdit',
          english: 'Editing needs the “{permission}” permission, which your role does not have',
          vars: { permission: facts.editCapabilityLabel },
        },
      ];

  return { see, canEdit, edit };
}

function audienceReason(audience: ItemAudience): AccessReason {
  switch (audience) {
    case 'client_visible':
      return { key: 'AccessExplainer.audienceClient', english: 'The client can see it too' };
    case 'client_action_required':
      return {
        key: 'AccessExplainer.audienceClientAction',
        english: 'The client can see it and is asked to act on it',
      };
    default:
      return {
        key: 'AccessExplainer.audienceInternal',
        english: 'Visible to the team only — clients cannot see it',
      };
  }
}

/** Fill `{name}` placeholders. */
export function fillReason(text: string, vars: Readonly<Record<string, string>> = {}): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
