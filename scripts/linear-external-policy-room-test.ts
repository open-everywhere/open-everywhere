import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { readAudit, resolvePartition, defineSurface, registerSurfaces, _resetSurfacesForTest } from "@open-everywhere/core/agent/adapter-api.js";
import type { Domain } from "@open-everywhere/core/agent/memory/domain.js";
import { removeTempDir } from "../packages/core/scripts/_temp-dir.js";

const dir = join(tmpdir(), `open-everywhere-linear-external-policy-room-${process.pid}`);
await removeTempDir(dir);
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.LINEAR_API_KEY = "linear-test-key";

const { registerLinearProvider } = await import("@open-everywhere/provider-linear/agent/register.js");
registerLinearProvider();
const { linearOnAgentSession } = await import("@open-everywhere/provider-linear/agent/channels/linear.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface FetchCall {
  readonly url: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fakeLinearHttp = (async (url: unknown, init: { body?: unknown }) => {
  const u = String(url);
  calls.push({ url: u, body: String(init?.body ?? "") });
  if (u.includes("api.linear.app")) return resp(200, { data: { agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } } });
  return resp(500, { error: "unexpected host" });
}) as typeof fetch;

const ORG = "orglin";
const bindableOf = (teamId: string) => ({
  channel: { kind: "linear" as const },
  session: { auth: { current: { attributes: { organization_id: ORG, team_id: teamId }, principalId: "creator-1", principalType: "linear-user" } } },
});
const declaredPart = resolvePartition(bindableOf("public-team") as never);
const undeclaredPart = resolvePartition(bindableOf("plain-team") as never);

const event = (teamId: string, sessionId: string): unknown => ({
  action: "created",
  kind: "agent_session",
  organizationId: ORG,
  previousComments: [],
  delivery: { id: `d-${sessionId}` },
  agentSession: { id: sessionId, creator: { id: "creator-1" }, issueId: "issue-1", issue: { id: "issue-1", identifier: "CAP-1" } },
  raw: { agentSession: { issue: { team: { id: teamId } } } },
});
const drive = async (teamId: string, sessionId: string) => {
  calls = [];
  const res = await linearOnAgentSession({} as never, event(teamId, sessionId) as never);
  const posted = calls.filter((c) => c.url.includes("api.linear.app")).map((c) => c.body);
  return { res, posted };
};

registerSurfaces([defineSurface({ key: `linear/${ORG}/public-team`, trust: "public" })]);

const SILENT_DOMAINS: readonly Domain[] = [{ name: "org", match: "org", externalPolicy: { roomGrain: "silent" } }];
registerConfig({
  loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
  loadDomains: () => SILENT_DOMAINS, loadSilos: () => [], domainsForSurface: () => [],
});

await withPatchedFetch(fakeLinearHttp, async () => {
const silenced = await drive("public-team", "as-silenced");
ok(silenced.res === null, "room grain: a declared-public team under `silent` DROPS the native mention before any turn (returns null)");
const activityWrites = silenced.posted.filter((b) => b.includes("AgentActivityCreate"));
ok(activityWrites.length === 1, "🔴 OPE-885 room grain: a silenced room's EXPLICIT mention creates EXACTLY ONE Agent Activity");
ok(activityWrites[0]!.includes('\\"type\\":\\"response\\"') || activityWrites[0]!.includes('"type":"response"'), "🔴 OPE-885: it is a `response` activity — the only type that TERMINATES the session");
ok(
  activityWrites[0]!.includes("can't help") || activityWrites[0]!.includes("can\\u0027t help"),
  "🔴 OPE-885: the body is the fixed host ack, not model prose",
);
ok(
  !/external space|organisation|guest|staying quiet/i.test(activityWrites[0]!),
  "🔴 OPE-885: the ack names no room configuration, no organisation and no classification — an agent activity is readable by everyone who can open the issue",
);
ok(
  !silenced.posted.some((b) => b.includes('"stop"')),
  "OPE-884 room grain (explicit): no `stop` signal is sent — the real API refuses it on any non-`prompt` activity",
);
ok(
  !silenced.posted.some((b) => b.includes("ephemeral")),
  "OPE-884 room grain (explicit): the ack is NOT ephemeral — an ephemeral activity neither terminates nor tells the member anything",
);
const suppressedRows = (await readAudit({ org: declaredPart.org, action: "linear.external_policy_suppressed" })).filter((r) => r.surface === declaredPart.surfaceKey);
ok(
  suppressedRows.length === 1 && suppressedRows[0]!.detail?.verdict === "silent-room",
  "room grain: ONE linear.external_policy_suppressed audit row names the surface with verdict silent-room",
);
ok(suppressedRows[0]!.detail?.rendering === "ack", "🔴 OPE-885: the row records rendering:\"ack\" — an operator can tell a closed session from a hanging one");
ok(suppressedRows[0]!.detail?.agentSessionId === "as-silenced", "OPE-885: the row names the session the ack closed");

const undeclared = await drive("plain-team", "as-undeclared");
ok(
  undeclared.res !== null && (undeclared.res as { auth?: unknown }).auth !== undefined,
  "room grain: an UNDECLARED team under the SAME `silent` policy DISPATCHES (negative control — undeclared is not external)",
);
ok(
  (await readAudit({ org: undeclaredPart.org, action: "linear.external_policy_suppressed" })).filter((r) => r.surface === undeclaredPart.surfaceKey).length === 0,
  "room grain: the undeclared team writes NO suppression audit row",
);

registerConfig({
  loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
  loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [],
});
const shippedDefault = await drive("public-team", "as-shipped");
ok(shippedDefault.res === null, "🔴 room grain: the SAME declared-public team is SILENCED under the shipped `silent` default, with no declaration at all");

const ENGAGE_DOMAINS: readonly Domain[] = [{ name: "org", match: "org", externalPolicy: { roomGrain: "engage" } }];
registerConfig({
  loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {},
  loadDomains: () => ENGAGE_DOMAINS, loadSilos: () => [], domainsForSurface: () => [],
});
const optOut = await drive("public-team", "as-optout");
ok(
  optOut.res !== null && (optOut.res as { auth?: unknown }).auth !== undefined,
  "room grain: the SAME declared-public team DISPATCHES under the `engage` opt-out (negative control — the opt-out restores the old behaviour)",
);

});
_resetSurfacesForTest();
await removeTempDir(dir);
console.log(`\n✓ linear-external-policy-room: ${n} assertions passed (silent drop + audit on a declared-public team, undeclared-team and engage-opt-out negative controls, shipped-default pin)`);
