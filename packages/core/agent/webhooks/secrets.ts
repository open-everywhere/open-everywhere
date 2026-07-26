import { getSecretVia } from "../access/credentials.js";
import { hookSecretRefs, type WebhookHook } from "./config.js";

function debug(msg: string): void {
  console.log(`[open-everywhere:webhooks] ${msg}`);
}

export interface ResolveHookKeysDeps {
  readonly getSecret?: (broker: string, ref: string) => Promise<string>;
  readonly log?: (msg: string) => void;
}

export async function resolveHookKeys(hook: WebhookHook, deps: ResolveHookKeysDeps = {}): Promise<readonly string[]> {
  const getSecret = deps.getSecret ?? ((broker: string, ref: string) => getSecretVia(broker, ref));
  const log = deps.log ?? debug;
  const refs = hookSecretRefs(hook);
  const keys: string[] = [];

  for (const [i, ref] of refs.entries()) {
    let value: string | undefined;
    try {
      value = await getSecret(hook.broker, ref);
    } catch (err) {
      if (i === 0) {
        log(`hook "${hook.id}": current secret (secretRef[0], broker "${hook.broker}") did not resolve — no keys, deliveries will 401: ${String(err instanceof Error ? err.message : err)}`);
        return [];
      }
      log(`hook "${hook.id}": previous secret (secretRef[${i}], broker "${hook.broker}") did not resolve — treating the rotation as complete`);
      continue;
    }
    if (!value) {
      if (i === 0) {
        log(`hook "${hook.id}": current secret (secretRef[0], broker "${hook.broker}") resolved empty — no keys, deliveries will 401`);
        return [];
      }
      log(`hook "${hook.id}": previous secret (secretRef[${i}], broker "${hook.broker}") resolved empty — dropping it`);
      continue;
    }
    keys.push(value);
  }
  return keys;
}
