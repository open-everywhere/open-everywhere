
import {
  extractGitHubInstallationEvent,
  handleGitHubInstallationDelivery,
  type GitHubInstallationDeps,
} from "../agent/channels/github-installations.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const OWNER = "acme";
const NOW = () => "2026-07-25T10:00:00.000Z";

function installationPayload(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    installation: {
      id: 4242,
      account: { login: OWNER, type: "Organization" },
      repository_selection: "selected",
    },
    ...extra,
  };
}

for (const action of ["created", "unsuspend", "new_permissions_accepted"]) {
  const ev = extractGitHubInstallationEvent("installation", installationPayload(action));
  ok(ev?.effect === "learn", `installation/${action} → learn`);
}
for (const action of ["deleted", "suspend"]) {
  const ev = extractGitHubInstallationEvent("installation", installationPayload(action));
  ok(ev?.effect === "revoke", `installation/${action} → revoke`);
}
ok(extractGitHubInstallationEvent("installation", installationPayload("edited")) === null, "an unknown action is ignored (fail-closed, no half-formed row)");

ok(extractGitHubInstallationEvent("issue_comment", installationPayload("created")) === null, "issue_comment is not an installation delivery (the ambient leg owns it)");
ok(extractGitHubInstallationEvent("pull_request", installationPayload("created")) === null, "pull_request is not an installation delivery");

{
  const ev = extractGitHubInstallationEvent("installation", installationPayload("created"))!;
  ok(ev.owner === OWNER, "owner comes from installation.account.login");
  ok(ev.installationId === "4242", "a NUMERIC installation.id is stringified (the mint API takes a path segment)");
  ok(ev.accountType === "Organization", "accountType comes from installation.account.type");
  ok(ev.repositorySelection === "selected", "repositorySelection comes from the installation");
  ok(ev.action === "created", "the raw action rides into the event (the audit row's why)");
}
{
  const p = installationPayload("created");
  (p["installation"] as Record<string, unknown>)["id"] = "99";
  ok(extractGitHubInstallationEvent("installation", p)?.installationId === "99", "a STRING installation.id is accepted verbatim");
}
{
  const p = installationPayload("created");
  (p["installation"] as Record<string, unknown>)["id"] = { nested: true };
  ok(extractGitHubInstallationEvent("installation", p) === null, "a non-scalar installation.id is refused, never coerced to [object Object]");
}

ok(extractGitHubInstallationEvent("installation", { action: "created" }) === null, "no installation object → null");
{
  const p = installationPayload("created");
  delete (p["installation"] as Record<string, unknown>)["account"];
  ok(extractGitHubInstallationEvent("installation", p) === null, "no account.login → null (an installation with no owner is unroutable)");
}
{
  const p = installationPayload("created");
  (p["installation"] as Record<string, unknown>)["id"] = undefined;
  ok(extractGitHubInstallationEvent("installation", p) === null, "no installation.id → null");
}

{
  const ev = extractGitHubInstallationEvent(
    "installation_repositories",
    installationPayload("added", { repository_selection: "all", repositories_added: [{ id: 1 }, { id: 2 }] }),
  )!;
  ok(ev.effect === "learn", "installation_repositories/added → learn (refresh, never a no-op)");
  ok(ev.repositorySelection === "all", "the TOP-LEVEL repository_selection wins over the installation's pre-change copy");
  ok(ev.repositoryCount === 2, "repositories_added is counted (diagnostics only — the repo list is never stored)");
}
{
  const ev = extractGitHubInstallationEvent(
    "installation_repositories",
    installationPayload("removed", { repository_selection: "selected", repositories_removed: [{ id: 3 }] }),
  )!;
  ok(ev.effect === "learn" && ev.repositoryCount === 1, "installation_repositories/removed → learn, counting repositories_removed");
}

{
  const recorded: Record<string, unknown>[] = [];
  const forgotten: string[] = [];
  const audits: { action: string; detail: Record<string, unknown>; workspace: string }[] = [];
  const deps: GitHubInstallationDeps = {
    record: async (rec) => void recorded.push(rec),
    forget: async (owner) => {
      forgotten.push(owner);
      return true;
    },
    audit: async (action, detail, workspace) => void audits.push({ action, detail, workspace }),
    now: NOW,
  };

  await handleGitHubInstallationDelivery(extractGitHubInstallationEvent("installation", installationPayload("created"))!, deps);
  ok(recorded.length === 1 && forgotten.length === 0, "learn records exactly once and forgets nothing");
  ok(recorded[0]!["owner"] === OWNER && recorded[0]!["installationId"] === "4242", "the recorded row carries owner + installation id");
  ok(recorded[0]!["updatedAt"] === NOW(), "the recorded row is stamped with the injected clock");
  ok(audits.length === 1 && audits[0]!.action === "surface.app_installed", "learn writes ONE surface.app_installed row");
  ok(audits[0]!.workspace === OWNER, "the audit row's workspace is the installing owner");
  ok(audits[0]!.detail["installationId"] === "4242" && audits[0]!.detail["action"] === "created", "the audit detail carries the installation id + the raw action");
}

{
  const recorded: Record<string, unknown>[] = [];
  const audits: { action: string; detail: Record<string, unknown>; workspace: string }[] = [];
  const deps: GitHubInstallationDeps = {
    record: async (rec) => void recorded.push(rec),
    forget: async () => true,
    audit: async (action, detail, workspace) => void audits.push({ action, detail, workspace }),
    now: NOW,
  };
  await handleGitHubInstallationDelivery(extractGitHubInstallationEvent("installation", installationPayload("deleted"))!, deps);
  ok(recorded.length === 0, "revoke records nothing");
  ok(audits.length === 1 && audits[0]!.action === "surface.app_uninstalled", "revoke writes ONE surface.app_uninstalled row");
  ok(audits[0]!.detail["removed"] === true, "the audit detail reports whether a row was actually cleared");
}
{
  const audits: { action: string; detail: Record<string, unknown> }[] = [];
  await handleGitHubInstallationDelivery(extractGitHubInstallationEvent("installation", installationPayload("suspend"))!, {
    record: async () => {},
    forget: async () => false,
    audit: async (action, detail) => void audits.push({ action, detail }),
    now: NOW,
  });
  ok(audits[0]!.action === "surface.app_uninstalled" && audits[0]!.detail["removed"] === false, "revoking an unknown owner audits removed:false, never throws");
}

{
  const audits: string[] = [];
  let threw = false;
  try {
    await handleGitHubInstallationDelivery(extractGitHubInstallationEvent("installation", installationPayload("created"))!, {
      record: async () => {
        throw new Error("store down");
      },
      forget: async () => false,
      audit: async (action) => void audits.push(action),
      now: NOW,
    });
  } catch {
    threw = true;
  }
  ok(threw, "a failed durable write propagates to the route (never swallowed here)");
  ok(audits.length === 0, "a failed durable write writes NO audit row (never audit an install we didn't record)");
}

console.log(`\n✓ github-installations: ${passed} assertions passed`);
