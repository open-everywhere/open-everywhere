import assert from "node:assert/strict";
import { readLinearIssue } from "../agent/channels/linear-api.js";
import { setLinearIssueState, assignLinearIssue, addLinearIssueLabel, linearEntityAdapter } from "../agent/channels/linear-actions.js";
import { resolveLinearTeamId, createLinearIssue, linearTicketCreateAdapter } from "../agent/channels/linear-create.js";
import { _resetLinearMintCache } from "../agent/channels/linear-credentials.js";
import { registerLinearProvider } from "../agent/register.js";
import { defineDomain, overrideSettingsForTest, type BindableContext, type Domain } from "@open-everywhere/core/agent/adapter-api.js";

registerLinearProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SOAK_ORG = "1a000000-0000-4000-8000-000000000002";
const PRIMARY_TOKEN = "primary_static_token";
const SOAK_MINTED = "soak_minted_token";

const SAVED: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in SAVED)) SAVED[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
setEnv("LINEAR_AGENT_ACCESS_TOKEN", PRIMARY_TOKEN);
setEnv("LINEAR_ACCESS_TOKEN", undefined);
setEnv("LINEAR_API_KEY", undefined);
setEnv("LINEAR_API_TOKEN", undefined);
overrideSettingsForTest({ linear: { organizationId: "" } });
setEnv("LINEAR_APP_SOAK_ORG_ID", SOAK_ORG);
setEnv("LINEAR_APP_SOAK_CLIENT_ID", "soak-client-id");
setEnv("LINEAR_APP_SOAK_CLIENT_SECRET", "soak-client-secret");

let bearers: string[] = [];
const savedFetch = globalThis.fetch;
function stubLinear(graphqlData: unknown): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: SOAK_MINTED, expires_in: 3600 }), { status: 200 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    bearers.push(headers["authorization"] ?? headers["Authorization"] ?? "(none)");
    return new Response(JSON.stringify({ data: graphqlData }), { status: 200 });
  }) as unknown as typeof fetch;
}
const lastBearer = (): string => bearers[bearers.length - 1] ?? "(no call)";
function reset(): void {
  bearers = [];
  _resetLinearMintCache();
}

function ctx(attrs: Record<string, string> = {}): BindableContext {
  return { channel: { kind: "linear" }, session: { auth: { current: { attributes: attrs } } } } as unknown as BindableContext;
}

const FENCE_DOMAINS: readonly Domain[] = [
  defineDomain({ name: "soak-domain", reach: [`linear/${SOAK_ORG}`] }),
  defineDomain({ name: "dev-fallback-domain", reach: ["linear/dev/default"] }),
];

try {
  {
    stubLinear({ issue: { id: "i1", identifier: "SOAK-3", title: "t", description: "d", state: { name: "Todo", type: "unstarted" }, comments: { nodes: [], pageInfo: { hasNextPage: false } } } });

    reset();
    await readLinearIssue("SOAK-3", { organizationId: SOAK_ORG });
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, `🔴 THE FIX: reading a SOAK-workspace issue presents the SOAK token — got "${lastBearer()}"`);

    reset();
    await readLinearIssue("SOAK-3", {});
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: the same read with NO organization id still presents the PRIMARY token (unchanged behaviour)");
  }

  {
    stubLinear({ issue: { team: { states: { nodes: [{ id: "s1", name: "Done" }] } } } });
    reset();
    await assert.rejects(() => setLinearIssueState("SOAK-3", "Bogus", { organizationId: SOAK_ORG }), /no state named/);
    passed++;
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: setState's team-STATES lookup presents the SOAK token");
    reset();
    await assert.rejects(() => setLinearIssueState("SOAK-3", "Bogus", {}), /no state named/);
    passed++;
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: setState's lookup with no organization id presents the PRIMARY token");

    stubLinear({ issue: { team: { states: { nodes: [{ id: "s1", name: "Done" }] } } }, issueUpdate: { success: true } });
    reset();
    await setLinearIssueState("SOAK-3", "done", { organizationId: SOAK_ORG });
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${SOAK_MINTED}`), `🔴 THE FIX: setState's lookup AND its issueUpdate mutation both present the SOAK token — got ${JSON.stringify(bearers)}`);
    reset();
    await setLinearIssueState("SOAK-3", "done", {});
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`), "NEGATIVE CONTROL: setState with no organization id presents the PRIMARY token throughout");

    stubLinear({ users: { nodes: [{ id: "u1", email: "alice@acme.com" }] }, issueUpdate: { success: true } });
    reset();
    await assignLinearIssue("SOAK-3", "alice@acme.com", { organizationId: SOAK_ORG });
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${SOAK_MINTED}`), `🔴 THE FIX: assign's user-lookup AND its issueUpdate mutation both present the SOAK token — got ${JSON.stringify(bearers)}`);
    reset();
    await assignLinearIssue("SOAK-3", "alice@acme.com", {});
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`), "NEGATIVE CONTROL: assign with no organization id presents the PRIMARY token throughout");

    stubLinear({ issue: { team: { labels: { nodes: [{ id: "l1", name: "bug" }] } } }, issueAddLabel: { success: true } });
    reset();
    await addLinearIssueLabel("SOAK-3", "bug", { organizationId: SOAK_ORG });
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${SOAK_MINTED}`), `🔴 THE FIX: addLabel's team-LABELS lookup AND its issueAddLabel mutation both present the SOAK token — got ${JSON.stringify(bearers)}`);
    reset();
    await addLinearIssueLabel("SOAK-3", "bug", {});
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`), "NEGATIVE CONTROL: addLabel with no organization id presents the PRIMARY token throughout");
  }

  {
    stubLinear({ teams: { nodes: [{ id: "t1", key: "SOAK" }] } });
    reset();
    await resolveLinearTeamId("SOAK", { organizationId: SOAK_ORG });
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: resolving a SOAK-workspace team key presents the SOAK token");
    reset();
    await resolveLinearTeamId("SOAK", {});
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: resolving a team with no organization id presents the PRIMARY token");

    stubLinear({ teams: { nodes: [{ id: "t1", key: "SOAK" }] }, issueCreate: { success: true, issue: { id: "i9", identifier: "SOAK-9" } } });
    reset();
    await createLinearIssue("SOAK", { title: "x", body: "y" }, { organizationId: SOAK_ORG });
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${SOAK_MINTED}`), `🔴 THE FIX: creating in a SOAK-workspace team presents the SOAK token throughout — got ${JSON.stringify(bearers)}`);
    reset();
    await createLinearIssue("SOAK", { title: "x", body: "y" }, {});
    ok(bearers.length === 2 && bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`), "NEGATIVE CONTROL: creating with no organization id presents the PRIMARY token throughout");
  }

  {
    stubLinear({ issue: { team: { labels: { nodes: [{ id: "l1", name: "bug" }] } } }, issueAddLabel: { success: true } });
    reset();
    await linearEntityAdapter.addLabel!("SOAK-3", "bug", SOAK_ORG);
    ok(bearers.every((b) => b === `Bearer ${SOAK_MINTED}`), "🔴 THE FIX: linearEntityAdapter.addLabel's third argument (organizationId) reaches the credential seam");
    reset();
    await linearEntityAdapter.addLabel!("SOAK-3", "bug", undefined);
    ok(bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`), "NEGATIVE CONTROL: linearEntityAdapter.addLabel with organizationId=undefined presents the PRIMARY token");

    stubLinear({ teams: { nodes: [{ id: "t1", key: "SOAK" }] }, issueCreate: { success: true, issue: { id: "i9", identifier: "SOAK-9" } } });
    reset();
    await linearTicketCreateAdapter.create("SOAK", { title: "x", body: "y" }, SOAK_ORG);
    ok(bearers.every((b) => b === `Bearer ${SOAK_MINTED}`), "🔴 THE FIX: linearTicketCreateAdapter.create's third argument (organizationId) reaches the credential seam");
    reset();
    await linearTicketCreateAdapter.create("SOAK", { title: "x", body: "y" }, undefined);
    ok(bearers.every((b) => b === `Bearer ${PRIMARY_TOKEN}`), "NEGATIVE CONTROL: linearTicketCreateAdapter.create with organizationId=undefined presents the PRIMARY token");
  }

  {
    stubLinear({ issue: { team: { id: "team-soak", private: false } } });
    reset();
    await Promise.resolve(linearEntityAdapter.checkAccess!(ctx({ organization_id: SOAK_ORG }), "SOAK-3", FENCE_DOMAINS)).catch(() => undefined);
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: the write fence's team lookup (enrichIssueTeam) presents the SOAK token when the asking turn names the SOAK workspace");
    reset();
    await Promise.resolve(linearEntityAdapter.checkAccess!(ctx({}), "SOAK-3", FENCE_DOMAINS)).catch(() => undefined);
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: the write fence's team lookup with no organization on the turn presents the PRIMARY token");

    stubLinear({ teams: { nodes: [{ id: "t1", key: "SOAK" }] } });
    reset();
    await Promise.resolve(linearTicketCreateAdapter.checkAccess!(ctx({ organization_id: SOAK_ORG }), "SOAK", FENCE_DOMAINS)).catch(() => undefined);
    ok(lastBearer() === `Bearer ${SOAK_MINTED}`, "🔴 THE FIX: the create fence's team-resolution lookup presents the SOAK token when the asking turn names the SOAK workspace");
    reset();
    await Promise.resolve(linearTicketCreateAdapter.checkAccess!(ctx({}), "SOAK", FENCE_DOMAINS)).catch(() => undefined);
    ok(lastBearer() === `Bearer ${PRIMARY_TOKEN}`, "NEGATIVE CONTROL: the create fence's team-resolution lookup with no organization on the turn presents the PRIMARY token");
  }
} finally {
  globalThis.fetch = savedFetch;
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

assert.ok(passed > 0);
console.log(`✓ linear-multi-org-tools: ${passed} assertions passed`);
