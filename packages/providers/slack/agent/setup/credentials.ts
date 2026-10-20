import { encryptedKvVault, operatorSecret, type EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import { SLACK_BOT_TOKEN_REF, SLACK_SIGNING_SECRET_REF } from "./install-state.js";

const SLACK_SIGNING_SECRET_NAME = "SLACK_SIGNING_SECRET";
const SLACK_BOT_TOKEN_NAME = "SLACK_BOT_TOKEN";

export type SlackSecretSource = "operator" | "store";

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

function slackCredentialSourceNotice(name: string): string {
  return (
    `[open-everywhere:slack-setup] ${name} is set as an operator secret (or as its env on-ramp), so this deployment uses that ` +
    `value and IGNORES the one /setup stored. That is the documented order (OPE-2231, OPE-2650): the operator secret wins, so ` +
    `landing this change cannot alter which Slack app an existing deployment speaks as. To use the /setup value instead, run ` +
    `\`oe secret rm ${name}\`, unset the env var of the same name, and redeploy.`
  );
}

export async function resolveSlackSecret(
  name: string,
  fromOperator: string,
  ref: string,
  deps: SlackCredentialDeps = {},
): Promise<ResolvedSlackSecret | undefined> {

  const vault = deps.vault;
  const now = (deps.now ?? Date.now)();
  const memoApplies = vault === undefined || deps.memo === true;
  const cached = memoApplies ? memo.get(ref) : undefined;
  const memoised = cached !== undefined && cached.until > now ? cached.value : undefined;

  if (fromOperator.length > 0) {
    if (!shadowChecked.has(name)) {
      shadowChecked.add(name);
      const stored = memoised ?? (await readStored(ref, vault));
      if (stored !== undefined) {
        noticed.add(name);
        console.warn(slackCredentialSourceNotice(name));
      }
    }
    return { value: fromOperator, source: "operator" };
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

async function fromOperatorSecret(name: string, deps: SlackCredentialDeps): Promise<string> {
  const value = deps.env !== undefined ? deps.env[name] : await operatorSecret(name);
  return (value ?? "").trim();
}

export async function slackSigningSecret(deps: SlackCredentialDeps = {}): Promise<string | undefined> {
  const fromOperator = await fromOperatorSecret(SLACK_SIGNING_SECRET_NAME, deps);
  return (await resolveSlackSecret(SLACK_SIGNING_SECRET_NAME, fromOperator, SLACK_SIGNING_SECRET_REF, deps))?.value;
}

export async function slackBotToken(deps: SlackCredentialDeps = {}): Promise<string | undefined> {
  const fromOperator = await fromOperatorSecret(SLACK_BOT_TOKEN_NAME, deps);
  return (await resolveSlackSecret(SLACK_BOT_TOKEN_NAME, fromOperator, SLACK_BOT_TOKEN_REF, deps))?.value;
}

export async function slackCredentialsConfigured(deps: SlackCredentialDeps = {}): Promise<boolean> {
  if ((await fromOperatorSecret(SLACK_BOT_TOKEN_NAME, deps)).length > 0) return true;
  return (await slackBotToken(deps)) !== undefined;
}

export async function slackOperatorSecretPresent(
  deps: SlackCredentialDeps = {},
): Promise<{ readonly signingSecret: boolean; readonly botToken: boolean }> {
  return {
    signingSecret: (await fromOperatorSecret(SLACK_SIGNING_SECRET_NAME, deps)).length > 0,
    botToken: (await fromOperatorSecret(SLACK_BOT_TOKEN_NAME, deps)).length > 0,
  };
}
