import { retrieveBotUser, NOTION_INGRESS_RETRY, type ResolvedNotionCredential } from "./notion-api.js";

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
    const overrideId = process.env.NOTION_BOT_USER_ID;
    const overrideName = process.env.NOTION_BOT_NAME;
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
}
