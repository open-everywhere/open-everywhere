import { retrieveBotUser, NOTION_INGRESS_RETRY, type ResolvedNotionCredential } from "./notion-api.js";
import { NOTION_CHANNEL_CREDENTIAL } from "./notion-credentials.js";
import { getSettings } from "@open-everywhere/core/agent/adapter-api.js";

export interface NotionOwnBotIds {
  readonly primary: string | undefined;
  readonly all: ReadonlySet<string>;
  readonly complete: boolean;
}

export async function collectNotionOwnBotIds(
  primary: string | undefined,
  siblingCredentialIds: readonly string[],
  resolve: (credentialId: string) => Promise<string | undefined>,
  canPost?: (credentialId: string) => Promise<boolean>,
): Promise<NotionOwnBotIds> {
  const all = new Set<string>();
  if (primary) all.add(primary);
  let complete = primary !== undefined;
  for (const credentialId of new Set(siblingCredentialIds)) {
    let id: string | undefined;
    try {
      id = await resolve(credentialId);
    } catch {
      id = undefined;
    }
    if (id) {
      all.add(id);
      continue;
    }
    let reachable = true;
    if (canPost) reachable = await reachableOnce(credentialId, canPost);
    if (reachable) complete = false;
  }
  return { primary, all, complete };
}

const reachableCache = new Map<string, Promise<boolean>>();

function reachableOnce(credentialId: string, canPost: (credentialId: string) => Promise<boolean>): Promise<boolean> {
  const hit = reachableCache.get(credentialId);
  if (hit) return hit;
  const verdict = canPost(credentialId).catch(() => true);
  reachableCache.set(credentialId, verdict);
  return verdict;
}

const botUserCache = new Map<string, Promise<{ id?: string; name?: string }>>();

function log(msg: string): void {
  console.log(`[open-everywhere:notion] ${msg}`);
}

export function resolveNotionBotUser(
  credentialId: string,
  credential: () => Promise<ResolvedNotionCredential | undefined>,
): () => Promise<{ id?: string; name?: string }> {
  return () => {
    const cached = botUserCache.get(credentialId);
    if (cached) return cached;
    const notion = getSettings().notion;
    const overrideId = credentialId === NOTION_CHANNEL_CREDENTIAL ? notion.botUserId : undefined;
    const overrideName = notion.botName;
    const named = (u: { id?: string; name?: string }) => ({ id: u.id, name: overrideName && overrideName.length > 0 ? overrideName : u.name });
    const resolved =
      overrideId && overrideId.length > 0
        ? Promise.resolve(named({ id: overrideId }))
        : credential()
            .then((cred) => (cred ? retrieveBotUser({ ...cred, retry: NOTION_INGRESS_RETRY }).then(named) : {}))
            .catch((err) => {
              log(`could not resolve bot user for credential "${credentialId}" (GET /v1/users/me failed): ${String(err)}`);
              return {};
            });
    botUserCache.set(credentialId, resolved);
    return resolved;
  };
}

export function _resetNotionBotUserCache(): void {
  botUserCache.clear();
  reachableCache.clear();
}
