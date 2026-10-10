import { __setTestValveForTest } from "../agent/testing/test-valves.js";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { execTool } from "./_tool-exec.js";
registerSlackFixtureMapper();

const dir = join(tmpdir(), `open-everywhere-create-ticket-tool-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
__setTestValveForTest("egress-spoof", false);

const { registerTicketCreateAdapter } = await import("../agent/channels/ticket-create.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { registerConfig } = await import("../agent/access/config.js");
const { markUntrustedIngestedThisTurn } = await import("../agent/access/taint-signal.js");
const createTicketDefault = (await import("../agent/tools/create_ticket.js")).default;
const { createTicketEntry } = await import("../agent/tools/create_ticket.js");
await import("../agent/approvals/flow.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;

const { registerIdentityMapper } = await import("../agent/identity/binding.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
for (const platform of ["tool-create-platform", "slack", "github", "notion"]) {
  registerIdentityMapper(platform, (c) => {
    const attrs = ((c as { session?: { auth?: { current?: { attributes?: Record<string, string> } } } }).session?.auth?.current?.attributes) ?? {};
    return {
      workspace: "W1",
      surface: attrs["room"] ?? platform,
      mode: "channel",
      visibility: "public",
      trust: "internal",
      principalId: attrs["user_id"] ?? "U_TEST",
    };
  });
}
const WORK_DOMAINS = [
  defineDomain({
    name: "filing",
    reach: ["tool-create-platform/W1/tool-create-platform", "github/W1/github"],
    credentials: [{ connector: "tool-create-platform", credential: "project-key", use: "filing-key" }],
  }),
  defineDomain({
    name: "filing-slack",
    reach: ["slack/W1/granted"],
    credentials: [{ connector: "tool-create-platform", credential: "project-key", use: "filing-key" }],
  }),
  defineDomain({ name: "chatonly", reach: ["slack/W1/slack"] }),
  defineDomain({
    name: "notion-entity",
    reach: ["notion/W1/notion"],
    credentials: [{ connector: "notion", credential: "team-key", use: "notion-work-key" }],
  }),
];
registerConfig({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/api"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "domain", domain: "filing" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => WORK_DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) =>
    WORK_DOMAINS.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const calls: { target: string; title: string; body: string }[] = [];
registerTicketCreateAdapter({
  platform: "tool-create-platform",
  workRole: "project-key",
  create: async (target, draft) => {
    calls.push({ target, title: draft.title, body: draft.body });
    return { ref: { platform: "tool-create-platform", id: `${target}#5` }, summary: `filed ${target}#5` };
  },
});

const { registerEntityActionAdapter } = await import("../agent/channels/entity-actions.js");
registerEntityActionAdapter({ platform: "notion", setState: async () => "ok" });

function ctx(platform: string, attrs: Record<string, string> = {}, sources?: readonly string[]): BindableContext {
  return {
    channel: { kind: platform },
    session: { auth: { current: { attributes: { ...attrs, ...(sources ? { oe_sources: sources.join(",") } : {}) } } } },
  } as unknown as BindableContext;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
async function armed<T>(tool: unknown, c: BindableContext): Promise<T | null> {
  const handler = (tool as { events: Record<string, Handler> }).events["session.started"];
  return (await handler({}, c)) as T | null;
}

const slackCtx = () => ctx("slack", { room: "granted", team_id: "T1", channel_id: "C1", channel_type: "channel", user_id: "U_PROPOSER" }, ["slack", "tool-create-platform"]);

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

async function inFakeSession<T>(fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return (g[key] as AsyncLocalStorage<unknown>).run(new FakeSession(), fn);
}

{
  ok((await armed(createTicketDefault, ctx("tool-create-platform", {}))) !== null, "create_ticket mounts on a session whose domain holds a create-adapter platform's work grant");
  ok(
    (await armed(createTicketDefault, ctx("slack", { room: "granted" }, ["slack", "tool-create-platform"]))) !== null,
    "…and on a Slack session in that SAME domain — the grant works from any surface, and needs no chat channel on the filing platform",
  );
  ok(
    (await armed(createTicketDefault, ctx("slack", {}, ["slack", "tool-create-platform"]))) === null,
    "🔴 OPE-953: a Slack session whose window SOURCES include a create-adapter platform, in a domain holding no grant, is ABSENT — chat topology confers nothing",
  );
  ok((await armed(createTicketDefault, ctx("slack", {}))) === null, "create_ticket is ABSENT on a chat-only session — a window with nowhere to file never sees the verb");
  ok((await armed(createTicketDefault, ctx("github", {}))) !== null, "create_ticket mounts on a github-origin session whose domain holds the repo grant (core-resident adapter)");
  ok((await armed(createTicketDefault, ctx("notion", {}))) === null, "create_ticket is ABSENT on notion — no create adapter is registered for it");
}

{
  const before = (await getOperationalStore().listPendingActions("default")).length;
  await assert.rejects(
    async () => {
      await execTool(createTicketEntry)({ platform: "tool-create-platform", target: "T-1", title: "x", body: "y" }, ctx("tool-create-platform", {}) as never);
    },
    /I can't file that ticket from here.*has no approval-card path.*no Slack or Discord channel to put the card in.*\.reach \(agent\/memory\/config\/domains\/.*\.ts\)/s,
    "a card-less proposing surface whose granted domain has no card venue refuses with the VENUE's copy (OPE-326) — its own verb plus the config change, not a flat 'this surface is not Slack'",
  );
  n++;
  ok((await getOperationalStore().listPendingActions("default")).length === before, "…and that refusal fires BEFORE any pending action is written");
}
{
  const before = (await getOperationalStore().listPendingActions("default")).length;
  let msg = "";
  try {
    await execTool(createTicketEntry)({ platform: "notion", target: "db-1", title: "x", body: "y" }, ctx("notion", {}) as never);
    assert.fail("expected a throw");
  } catch (err) {
    msg = String((err as Error).message);
  }
  ok(/not supported on "notion"/.test(msg), `a GRANTED destination with no CREATE adapter refuses at PROPOSE time, naming what is supported (${msg})`);
  ok(msg.includes("github"), "…naming the supported set rather than failing blank");
  ok((await getOperationalStore().listPendingActions("default")).length === before, "…and writes no pending row");
}
{
  await assert.rejects(
    async () => {
      await execTool(createTicketEntry)({ platform: "github", target: "acme/web", title: "x", body: "y" }, slackCtx() as never);
    },
    /not one of this session's work destinations/,
    "a destination this session may not address refuses (the destination gate reaches the tool)",
  );
  n++;
}

{
  __setTestValveForTest("egress-spoof", true);
  calls.length = 0;
  const out = await execTool(createTicketEntry)(
    { platform: "tool-create-platform", target: "T-9", title: "Login 500s on retry", body: "Steps: …" },
    slackCtx() as never,
  );
  ok(out.pending === true && typeof out.pendingId === "string", "a Slack-origin proposal posts a card and returns pending");
  ok(calls.length === 0, "NOTHING was filed — the creation waits for a human click, it does not run at propose time");
  const row = await getOperationalStore().getPendingAction("default", out.pendingId!);
  ok(row !== null && row!.kind === "ticket.create", "the pending row is kind ticket.create");
  const frozen = JSON.parse(row!.argsJson) as { platform: string; target: string; title: string; body: string; requestedBy: string; tainted?: boolean };
  ok(frozen.platform === "tool-create-platform" && frozen.target === "T-9", "the FROZEN args carry the RESOLVED destination, never the raw request shape");
  ok(frozen.title === "Login 500s on retry" && frozen.body === "Steps: …", "the frozen args carry the exact text that will be published");
  ok(frozen.requestedBy === "U_PROPOSER", "the frozen args carry the verified proposer");
  ok(frozen.tainted === false, "a clean turn freezes tainted:false");
  __setTestValveForTest("egress-spoof", false);
}

{
  __setTestValveForTest("egress-spoof", true);
  const out = await inFakeSession(async () => {
    markUntrustedIngestedThisTurn();
    return execTool(createTicketEntry)(
      { platform: "tool-create-platform", target: "T-10", title: "From a web page", body: "…" },
      slackCtx() as never,
    );
  });
  ok(out.pending === true, "a turn that ingested untrusted content STILL proposes — taint is reviewer scrutiny, not a refusal (the pr.open / ticket.set_state doctrine)");
  const row = await getOperationalStore().getPendingAction("default", out.pendingId!);
  const frozen = JSON.parse(row!.argsJson) as { tainted?: boolean };
  ok(frozen.tainted === true, "…and the taint flag is FROZEN onto the row so the card can warn the reviewer");
  __setTestValveForTest("egress-spoof", false);
}

console.log(`✓ ${n} create-ticket-tool assertions passed`);
