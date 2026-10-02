import { encryptedKvVault, SLACK_APP_REF_NAMESPACE, type EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";

export const SLACK_CLIENT_SECRET_REF = `${SLACK_APP_REF_NAMESPACE}client_secret`;
export const SLACK_SIGNING_SECRET_REF = `${SLACK_APP_REF_NAMESPACE}signing_secret`;
export const SLACK_BOT_TOKEN_REF = `${SLACK_APP_REF_NAMESPACE}bot_token`;
export const SLACK_PENDING_SIGNING_SECRET_REF = `${SLACK_APP_REF_NAMESPACE}pending_signing_secret`;
export const SLACK_COOKIE_KEY_REF = `${SLACK_APP_REF_NAMESPACE}cookie_key`;
export const SLACK_SETUP_CODE_REF = `${SLACK_APP_REF_NAMESPACE}setup_code`;
export const SLACK_INSTALL_REF = `${SLACK_APP_REF_NAMESPACE}install`;
export const SLACK_PENDING_REF = `${SLACK_APP_REF_NAMESPACE}pending`;

export interface SlackInstallState {
  readonly v: 1;
  readonly appId: string;
  readonly clientId: string;
  readonly teamId: string;
  readonly teamName?: string;
  readonly installerUserId: string;
  readonly installedAt: string;
}

export interface SlackInstallStateDeps {
  readonly vault?: EncryptedKvVault;
}

function vaultOf(deps: SlackInstallStateDeps): EncryptedKvVault {
  return deps.vault ?? encryptedKvVault();
}

export async function slackInstallState(deps: SlackInstallStateDeps = {}): Promise<SlackInstallState | undefined> {
  return (await readInstallRecord(deps)).state;
}

export type InstallRecordRead =
  | { readonly kind: "present"; readonly state: SlackInstallState }
  | { readonly kind: "absent"; readonly state: undefined }
  | { readonly kind: "unreadable"; readonly state: undefined };

export async function readInstallRecord(deps: SlackInstallStateDeps = {}): Promise<InstallRecordRead> {
  let raw: string | null;
  try {
    raw = await vaultOf(deps).read(SLACK_INSTALL_REF);
  } catch {
    return { kind: "unreadable", state: undefined };
  }
  if (raw === null) return { kind: "absent", state: undefined };
  const state = parseInstallState(raw);
  if (state === undefined) return { kind: "unreadable", state: undefined };
  return { kind: "present", state };
}

export function parseInstallState(raw: string): SlackInstallState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (r.v !== 1) return undefined;
  const str = (k: string): string | undefined => (typeof r[k] === "string" && (r[k] as string).length > 0 ? (r[k] as string) : undefined);
  const appId = str("appId");
  const clientId = str("clientId");
  const teamId = str("teamId");
  const installerUserId = str("installerUserId");
  const installedAt = str("installedAt");
  if (!appId || !clientId || !teamId || !installerUserId || !installedAt) return undefined;
  const teamName = str("teamName");
  return {
    v: 1,
    appId,
    clientId,
    teamId,
    installerUserId,
    installedAt,
    ...(teamName ? { teamName } : {}),
  };
}

export async function recordSlackInstall(state: SlackInstallState, deps: SlackInstallStateDeps = {}): Promise<void> {
  await vaultOf(deps).write(SLACK_INSTALL_REF, JSON.stringify(state), { connector: "slack", createdBy: "host:slack-setup" });
}

export async function reopenSlackSetup(deps: SlackInstallStateDeps = {}): Promise<boolean> {
  const vault = vaultOf(deps);
  return vault.withLock(SLACK_INSTALL_REF, async () => {
    await vault.delete(SLACK_SETUP_CODE_REF);
    await vault.delete(SLACK_COOKIE_KEY_REF);

    const reopened = await vault.delete(SLACK_INSTALL_REF);

    await vault.delete(SLACK_PENDING_SIGNING_SECRET_REF).catch(() => undefined);
    await vault.delete(SLACK_PENDING_REF).catch(() => undefined);
    return reopened;
  });
}
