export type GoogleChatAudience =
  | { readonly kind: "project-number"; readonly projectNumber: string }
  | { readonly kind: "endpoint-url"; readonly url: string };

export interface GoogleChatPolicy {
  readonly enabled: boolean;
  readonly audience: GoogleChatAudience | null;
  readonly workspace: string;
  readonly internalDomainIds: readonly string[];
  readonly directMessages: boolean;
}

export const DEFAULT_GOOGLE_CHAT_POLICY: GoogleChatPolicy = {
  enabled: false,
  audience: null,
  workspace: "workspace",
  internalDomainIds: [],
  directMessages: true,
};

const WORKSPACE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const PROJECT_NUMBER = /^[0-9]{1,20}$/u;
const DOMAIN_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function validateGoogleChatPolicy(policy: GoogleChatPolicy): readonly string[] {
  const problems: string[] = [];
  if (!WORKSPACE_SEGMENT.test(policy.workspace)) {
    problems.push(`workspace "${policy.workspace}" must be a lowercase segment (a-z, 0-9, "-"), at most 63 characters.`);
  }
  for (const id of policy.internalDomainIds) {
    if (!DOMAIN_ID.test(id)) problems.push(`internalDomainIds entry "${id}" is not a Google Workspace domain id.`);
  }
  const a = policy.audience;
  if (a !== null) {
    if (a.kind === "project-number") {
      if (!PROJECT_NUMBER.test(a.projectNumber)) problems.push("audience.projectNumber must be the numeric Google Cloud project number.");
    } else if (a.kind === "endpoint-url") {
      let url: URL | undefined;
      try {
        url = new URL(a.url);
      } catch {
        url = undefined;
      }
      if (url?.protocol !== "https:") problems.push("audience.url must be the app's https endpoint URL.");
    } else {
      problems.push(`audience.kind must be "project-number" or "endpoint-url".`);
    }
  }
  if (policy.enabled && a === null) problems.push("an enabled policy must name its audience — without it no event can be verified.");
  return problems;
}

let registered: GoogleChatPolicy = DEFAULT_GOOGLE_CHAT_POLICY;

export function registerGoogleChatPolicy(policy: GoogleChatPolicy): void {
  const problems = validateGoogleChatPolicy(policy);
  if (problems.length > 0) throw new Error(`agent/google-chat/policy.ts is invalid:\n  - ${problems.join("\n  - ")}`);
  registered = policy;
}

export function googleChatPolicy(): GoogleChatPolicy {
  return registered;
}

export function googleChatSurfaceKey(policy: GoogleChatPolicy, space: string): string {
  return `google-chat/${policy.workspace}/${spaceId(space)}`;
}

function spaceId(space: string): string {
  return space.slice(space.indexOf("/") + 1);
}
