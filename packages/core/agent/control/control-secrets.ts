import { getOperatorSecret, OperatorSecretNotSetError, operatorSecretEnvFallbackPresent } from "../credentials/operator-secrets.js";

export const CONTROL_READ_TOKENS_SECRET = "OE_CONTROL_READ_TOKENS";
export const CONTROL_INJECT_TOKENS_SECRET = "OE_CONTROL_INJECT_TOKENS";
export const CONTROL_OAUTH_SIGNING_SECRET = "OE_CONTROL_OAUTH_SIGNING_SECRET";
export const ADMIN_STATIC_TOKEN_SECRET = "OE_ADMIN_STATIC_TOKEN";

export const CONTROL_SECRET_TTL_MS = 30_000;

const memo = new Map<string, { readonly value: string | undefined; readonly envPresent: boolean; readonly until: number }>();

export function resetControlSecretCache(): void {
  memo.clear();
}

export async function controlSecret(name: string, now: number = Date.now()): Promise<string | undefined> {
  const envPresent = operatorSecretEnvFallbackPresent(name);
  const hit = memo.get(name);
  if (hit !== undefined && hit.until > now && hit.envPresent === envPresent) return hit.value;
  let value: string | undefined;
  try {
    const trimmed = (await getOperatorSecret(name)).value.trim();
    value = trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if (!(err instanceof OperatorSecretNotSetError)) throw err;
    value = undefined;
  }
  memo.set(name, { value, envPresent, until: now + CONTROL_SECRET_TTL_MS });
  return value;
}
