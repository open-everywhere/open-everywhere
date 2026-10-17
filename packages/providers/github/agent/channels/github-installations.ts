import type { AuditDetail, AuditDetailBuilder } from "@open-everywhere/core/agent/adapter-api.js";

export interface GitHubInstallationEvent {
  readonly effect: "learn" | "revoke";
  readonly action: string;
  readonly owner: string;
  readonly installationId: string;
  readonly accountType?: string;
  readonly repositorySelection?: string;
  readonly repositoryCount?: number;
}

const LEARN_ACTIONS = new Set(["created", "unsuspend", "new_permissions_accepted", "added", "removed"]);
const REVOKE_ACTIONS = new Set(["deleted", "suspend"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function idOf(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

function countOf(v: unknown): number | undefined {
  return Array.isArray(v) ? v.length : undefined;
}

export function extractGitHubInstallationEvent(eventType: string, payload: Record<string, unknown>): GitHubInstallationEvent | null {
  if (eventType !== "installation" && eventType !== "installation_repositories") return null;
  const action = str(payload["action"]);
  if (!action) return null;
  const effect = LEARN_ACTIONS.has(action) ? "learn" : REVOKE_ACTIONS.has(action) ? "revoke" : undefined;
  if (!effect) return null;

  const installation = payload["installation"];
  if (typeof installation !== "object" || installation === null) return null;
  const inst = installation as Record<string, unknown>;
  const installationId = idOf(inst["id"]);
  if (!installationId) return null;

  const account = typeof inst["account"] === "object" && inst["account"] !== null ? (inst["account"] as Record<string, unknown>) : undefined;
  const owner = str(account?.["login"]);
  if (!owner) return null;

  const repositorySelection = str(payload["repository_selection"]) ?? str(inst["repository_selection"]);
  const repositoryCount =
    countOf(payload["repositories"]) ?? countOf(payload["repositories_added"]) ?? countOf(payload["repositories_removed"]);

  return {
    effect,
    action,
    owner,
    installationId,
    ...(str(account?.["type"]) ? { accountType: str(account?.["type"])! } : {}),
    ...(repositorySelection ? { repositorySelection } : {}),
    ...(repositoryCount !== undefined ? { repositoryCount } : {}),
  };
}

export interface GitHubInstallationDeps {
  readonly record: (rec: {
    owner: string;
    installationId: string;
    accountType?: string;
    repositorySelection?: string;
    updatedAt: string;
  }) => Promise<void>;
  readonly forget: (owner: string) => Promise<boolean>;
  readonly audit: (action: string, detail: AuditDetail, workspace: string) => Promise<void>;
  readonly now?: () => string;
  readonly log?: (msg: string) => void;
}

export async function handleGitHubInstallationDelivery(ev: GitHubInstallationEvent, deps: GitHubInstallationDeps): Promise<void> {
  const at = deps.now ? deps.now() : new Date().toISOString();
  const detail: AuditDetailBuilder = {
    action: ev.action,
    installationId: ev.installationId,
    ...(ev.accountType ? { accountType: ev.accountType } : {}),
    ...(ev.repositorySelection ? { repositorySelection: ev.repositorySelection } : {}),
    ...(ev.repositoryCount !== undefined ? { repositoryCount: ev.repositoryCount } : {}),
  };

  if (ev.effect === "revoke") {
    const removed = await deps.forget(ev.owner);
    deps.log?.(`installation ${ev.action} for ${ev.owner} — ${removed ? "discovered entry cleared" : "no discovered entry to clear"}`);
    await deps.audit("surface.app_uninstalled", { ...detail, removed }, ev.owner);
    return;
  }

  await deps.record({
    owner: ev.owner,
    installationId: ev.installationId,
    ...(ev.accountType ? { accountType: ev.accountType } : {}),
    ...(ev.repositorySelection ? { repositorySelection: ev.repositorySelection } : {}),
    updatedAt: at,
  });
  deps.log?.(`installation ${ev.action} for ${ev.owner} → installation ${ev.installationId} registered (no env edit needed)`);
  await deps.audit("surface.app_installed", detail, ev.owner);
}
