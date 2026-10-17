import { encryptedKvVault, type EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import { SLACK_BOT_TOKEN_REF, SLACK_SIGNING_SECRET_REF } from "./install-state.js";

const SLACK_SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET";
const SLACK_BOT_TOKEN_ENV = "SLACK_BOT_TOKEN";

export type SlackSecretSource = "env" | "store";

export interface SlackCredentialDeps {
  readonly vault?: EncryptedKvVault;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly memo?: boolean;
}

export interface ResolvedSlackSecret {
  readonly value: string;
  readonly source: SlackSecretSource;
}

const HIT_TTL_MS = 30_000;

const memo = new Map<string, { readonly value: string; readonly until: number }>();

const MISS_TTL_MS = 30_000;

const missUntil = new Map<string, number>();

export function resetSlackCredentialMemo(): void {
  memo.clear();
  missUntil.clear();
}

const noticed = new Set<string>();

const shadowChecked = new Set<string>();

export function resetSlackCredentialNotices(): void {
  noticed.clear();
  shadowChecked.clear();
}

function slackCredentialSourceNotice(envName: string): string {
  return (
    `[open-everywhere:slack-setup] ${envName} is set in the environment, so this deployment uses the environment value and ` +
    `IGNORES the one in the credential store. That is the documented order (OPE-2231): env wins, so landing this change cannot ` +
    `alter which Slack app an existing deployment speaks as. To use the stored value instead, unset ${envName} and redeploy.`
  );
}

export async function resolveSlackSecret(
  envName: string,
  fromEnv: string,
  ref: string,
  deps: SlackCredentialDeps = {},
): Promise<ResolvedSlackSecret | undefined> {

  const vault = deps.vault;
  const now = (deps.now ?? Date.now)();
  const memoApplies = vault === undefined || deps.memo === true;
  const cached = memoApplies ? memo.get(ref) : undefined;
  const memoised = cached !== undefined && cached.until > now ? cached.value : undefined;

  if (fromEnv.length > 0) {
    if (!shadowChecked.has(envName)) {
      shadowChecked.add(envName);
      const stored = memoised ?? (await readStored(ref, vault));
      if (stored !== undefined) {
        noticed.add(envName);
        console.warn(slackCredentialSourceNotice(envName));
      }
    }
    return { value: fromEnv, source: "env" };
  }

  if (memoised !== undefined) return { value: memoised, source: "store" };

  if (memoApplies) {
    const until = missUntil.get(ref);
    if (until !== undefined && until > now) return undefined;
  }

  const stored = await readStored(ref, vault);
  if (stored === undefined) {
    if (memoApplies) missUntil.set(ref, now + MISS_TTL_MS);
    return undefined;
  }
  if (memoApplies) {
    memo.set(ref, { value: stored, until: now + HIT_TTL_MS });
    missUntil.delete(ref);
  }
  return { value: stored, source: "store" };
}

async function readStored(ref: string, injected: EncryptedKvVault | undefined): Promise<string | undefined> {
  try {
    const value = await (injected ?? encryptedKvVault()).read(ref);
    return value === null || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

export async function slackSigningSecret(deps: SlackCredentialDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = (env[SLACK_SIGNING_SECRET_ENV] ?? "").trim();
  return (await resolveSlackSecret(SLACK_SIGNING_SECRET_ENV, fromEnv, SLACK_SIGNING_SECRET_REF, deps))?.value;
}

export async function slackBotToken(deps: SlackCredentialDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const fromEnv = (env[SLACK_BOT_TOKEN_ENV] ?? "").trim();
  return (await resolveSlackSecret(SLACK_BOT_TOKEN_ENV, fromEnv, SLACK_BOT_TOKEN_REF, deps))?.value;
}

export async function slackCredentialsConfigured(deps: SlackCredentialDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  if ((env[SLACK_BOT_TOKEN_ENV] ?? "").trim().length > 0) return true;
  return (await slackBotToken(deps)) !== undefined;
}

export function slackSecretEnvPresent(deps: SlackCredentialDeps = {}): { readonly signingSecret: boolean; readonly botToken: boolean } {
  const env = deps.env ?? process.env;
  return {
    signingSecret: (env[SLACK_SIGNING_SECRET_ENV] ?? "").trim().length > 0,
    botToken: (env[SLACK_BOT_TOKEN_ENV] ?? "").trim().length > 0,
  };
}
