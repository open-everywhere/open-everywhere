import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readAudit, resolvePartition, defineSurface, registerSurfaces, _resetSurfacesForTest, EXTERNAL_MENTION_ACK } from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";

const dir = join(tmpdir(), `open-everywhere-github-external-policy-room-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.GITHUB_APP_SLUG = "eve-bot";

const { registerGithubProvider } = await import("@open-everywhere/provider-github/agent/register.js");
registerGithubProvider();
const { githubOnComment } = await import("@open-everywhere/provider-github/agent/channels/github.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const { buildGitHubAuth } = await import("@open-everywhere/provider-github/agent/channels/github-identity.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const authBindable = (owner: string, repo: string) => ({
  channel: { kind: "github" as const },
  session: { auth: { current: buildGitHubAuth({ owner, repo, actorLogin: "capuser", conversationKind: "issue", issueNumber: 1 }) as unknown as { attributes?: Readonly<Record<string, string>> } } },
});
const declaredPart = resolvePartition(authBindable("public-org", "public-repo") as never);
const undeclaredPart = resolvePartition(authBindable("plain-org", "plain-repo") as never);

const comment = (): unknown => ({ body: "@eve-bot please help", author: { login: "capuser", id: 7, type: "User" }, raw: { author_association: "MEMBER" } });
const ctxFor = (owner: string, repo: string, posted: string[]): unknown => ({
  repository: { owner, name: repo, fullName: `${owner}/${repo}`, id: 1, private: false },
  conversation: { kind: "issue", issueNumber: 1, pullRequestNumber: null },
  github: { installationId: 123 },
  sender: { login: "capuser", id: 7, type: "User" },
  thread: { kind: "issue", post: async (t: string) => { posted.push(t); return { id: 1 }; }, react: async () => {} },
});
const drive = async (owner: string, repo: string) => {
  const posted: string[] = [];
  const res = await githubOnComment(ctxFor(owner, repo, posted) as never, comment() as never);
  return { res, posted };
};

registerSurfaces([defineSurface({ key: "github/public-org/public-repo", trust: "public" })]);

const SILENT_DOMAINS: readonly Domain[] = [{ name: "org", match: "org", externalPolicy: { roomGrain: "silent" } }];
registerConfig({
  loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
  loadDomains: () => SILENT_DOMAINS, loadSilos: () => [], domainsForSurface: () => [],
});

const silenced = await drive("public-org", "public-repo");
ok(silenced.res === null, "room grain: a declared-public repo under `silent` DROPS the mention before any turn (returns null)");
ok(
  silenced.posted.length === 1 && silenced.posted[0] === EXTERNAL_MENTION_ACK,
  "🔴 OPE-885: a silenced room's EXPLICIT @mention gets EXACTLY the fixed host ack, and no second message",
);
ok(
  !/quiet|external space|organisation|polic/i.test(silenced.posted[0]!),
  "🔴 OPE-885: the ack is NOT the room announcement — it says nothing about the room, so it discloses no configuration to a world-readable repo",
);
const suppressedRows = (await readAudit({ org: declaredPart.org, action: "github.external_policy_suppressed" })).filter((r) => r.surface === declaredPart.surfaceKey);
ok(
  suppressedRows.length === 1 && suppressedRows[0]!.detail?.verdict === "silent-room",
  "room grain: ONE github.external_policy_suppressed audit row names the surface with verdict silent-room",
);
ok(suppressedRows[0]!.detail?.rendering === "ack", "OPE-885: the row records rendering:\"ack\"");

const undeclared = await drive("plain-org", "plain-repo");
ok(
  undeclared.res !== null && (undeclared.res as { auth?: unknown }).auth !== undefined,
  "room grain: an UNDECLARED repo under the SAME `silent` policy DISPATCHES (negative control — undeclared is not external)",
);
ok(
  (await readAudit({ org: undeclaredPart.org, action: "github.external_policy_suppressed" })).filter((r) => r.surface === undeclaredPart.surfaceKey).length === 0,
  "room grain: the undeclared repo writes NO suppression audit row",
);

registerConfig({
  loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
  loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [],
});
const shippedDefault = await drive("public-org", "public-repo");
ok(
  shippedDefault.res !== null && (shippedDefault.res as { auth?: unknown }).auth !== undefined,
  "room grain: the SAME declared-public repo DISPATCHES under the shipped `engage` default (negative control — an upgrade changes nothing)",
);

_resetSurfacesForTest();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✓ github-external-policy-room: ${n} assertions passed (silent drop + audit on a declared-public repo, undeclared-repo and shipped-default negative controls)`);
