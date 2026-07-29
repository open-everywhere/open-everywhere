import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { registerLinearProvider } from "@open-everywhere/provider-linear/agent/register.js";
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";
import { capabilitiesForPlatform, readAudit, type BindableContext } from "@open-everywhere/core/agent/adapter-api.js";
import {
  supportedEntityActionPlatforms,
  entityActionFn,
  resolveEntityAction,
} from "@open-everywhere/core/agent/channels/entity-actions.js";
import {
  supportedTicketCreatePlatforms,
  ticketCreateFn,
  resolveTicketCreate,
} from "@open-everywhere/core/agent/channels/ticket-create.js";

const dir = join(tmpdir(), `open-everywhere-linear-integration-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PLATFORM;
process.env.LINEAR_API_KEY = "linear-test-key";

registerLinearProvider();
registerSlackProvider();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function ctx(platform: string, attrs: Record<string, string> = {}): BindableContext {
  return { channel: { kind: platform }, session: { auth: { current: { attributes: attrs } } } } as unknown as BindableContext;
}
function linearCtx(agentSessionId: string | undefined) {
  return {
    channel: { kind: "linear" },
    session: {
      auth: {
        current: {
          attributes: { organization_id: "ORG1", ...(agentSessionId ? { agent_session_id: agentSessionId } : {}) },
          principalId: "LU1",
          principalType: "linear-user",
        },
      },
    },
  };
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}
let calls: FetchCall[] = [];
let linearResponse: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: { data: { agentActivityCreate: { success: true, agentActivity: { id: "" } } } },
};
const realFetch = globalThis.fetch;
const resp = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
function fakeHttp(): void {
  globalThis.fetch = (async (url: unknown, init: { body?: unknown; method?: string }) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (u.includes("api.linear.app")) return resp(linearResponse.status, linearResponse.body);
    return resp(500, { error: "unexpected host" });
  }) as typeof fetch;
}
function restoreHttp(): void {
  globalThis.fetch = realFetch;
}

const reply = (await import("@open-everywhere/core/agent/tools/reply.js")).default;
const { resolveReplyTarget } = await import("@open-everywhere/core/agent/channels/reply-post.js");

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

type Handler = (event: unknown, c: unknown) => unknown;
interface ArmedTool {
  readonly description: string;
  readonly execute: (input: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>>;
}
const armReply = (tool: unknown, c: unknown): ArmedTool | null =>
  (tool as { events: Record<string, Handler> }).events["session.started"]({}, c) as ArmedTool | null;

assert.deepStrictEqual(
  capabilitiesForPlatform("linear"),
  { midTurnPost: true, reactions: false },
  "registerLinearProvider registers linear's manifest (midTurnPost via the `response` Agent Activity, no reactions)",
);
n++;

{
  const platforms = supportedEntityActionPlatforms();
  ok(platforms.includes("linear"), "linear entity adapter is registered by registerLinearProvider()");
  ok(platforms.includes("github"), "github entity adapter is registered (core module-load side effect)");
  ok(!platforms.includes("notion"), "notion is NOT an entity-action platform (no sane status/label mapping)");
  ok(typeof entityActionFn("linear", "setState") === "function", "linear declares setState");
  ok(typeof entityActionFn("linear", "assign") === "function", "linear declares assign");
  ok(typeof entityActionFn("linear", "addLabel") === "function", "linear declares addLabel");
  try {
    await resolveEntityAction(ctx("notion", {}), "addLabel", { platform: "notion", id: "page-1" }, []);
    assert.fail("expected a throw");
  } catch (err) {
    const msg = String((err as Error).message);
    ok(msg.includes("linear") && msg.includes("github"), "the addLabel refusal names BOTH linear and github (core + bundle composed)");
  }
}

{
  const platforms = supportedTicketCreatePlatforms();
  ok(platforms.includes("linear"), "linear's ticket-CREATE adapter is registered by registerLinearProvider()");
  ok(platforms.includes("github"), "github's ticket-CREATE adapter is registered (core module-load side effect)");
  ok(!platforms.includes("notion"), "notion registers NO create adapter — a database row's property schema can't be inferred, so it fails closed rather than faking a ticket");
  ok(typeof ticketCreateFn("linear") === "function", "linear declares create");
  try {
    await resolveTicketCreate(ctx("notion", {}), { platform: "notion", target: "db-1" }, []);
    assert.fail("expected a throw");
  } catch (err) {
    const msg = String((err as Error).message);
    ok(/not supported on "notion"/.test(msg), "create_ticket refuses on notion");
    ok(msg.includes("linear") && msg.includes("github"), "…naming BOTH linear and github as the supported set (core + bundle composed)");
  }
}

const linearArmed = armReply(reply, { channel: { kind: "linear" } });
ok(linearArmed !== null, "reply arms on a Linear session (mid-turn post via createLinearAgentActivity)");
const slackArmed = armReply(reply, { channel: { kind: "slack" } });
ok(slackArmed !== null && slackArmed.description === linearArmed!.description, "reply: ONE description on linear + slack (no per-surface variant)");

{
  const target = resolveReplyTarget(linearCtx("as-1") as never);
  ok(target?.platform === "linear" && (target as { agentSessionId: string }).agentSessionId === "as-1", "resolveReplyTarget: linear carries the agent session id (the reply anchor)");
  ok(resolveReplyTarget(linearCtx(undefined) as never) === null, "resolveReplyTarget: a session-less linear ctx → null (no anchor to post to)");
}

calls = [];
linearResponse = { status: 200, body: { data: { agentActivityCreate: { success: true, agentActivity: { id: "linear-act-42" } } } } };
fakeHttp();
await inSession(async () => {
  const armed = armReply(reply, linearCtx("as-1"))!;
  const res = await armed.execute({ text: "linear answer" }, linearCtx("as-1"));
  ok(res.posted === true && res.id === "linear-act-42", "reply: on Linear returns the created activity id");
  const gqlCall = calls.find((c) => c.url.includes("api.linear.app"));
  ok(gqlCall !== undefined && gqlCall.method === "POST", "reply: on Linear POSTs the AgentActivityCreate mutation");
  const payload = JSON.parse(gqlCall!.body) as { variables?: { input?: { agentSessionId?: string; content?: { body?: string; type?: string } } } };
  ok(payload.variables?.input?.agentSessionId === "as-1", "reply: on Linear posts onto the SAME agent session it was woken on");
  ok(payload.variables?.input?.content?.type === "response" && payload.variables?.input?.content?.body === "linear answer", "reply: on Linear posts a `response` activity carrying the model text (no stop signal, so the session stays open)");
  const audit = await readAudit({ org: "default", action: "reply.post" });
  ok(audit.some((r) => r.detail?.platform === "linear" && r.detail?.id === "linear-act-42"), "reply: audits a reply.post row stamped platform=linear");
});
restoreHttp();

await inSession(async () => {
  const armed = armReply(reply, linearCtx(undefined))!;
  await assert.rejects(() => armed.execute({ text: "x" }, linearCtx(undefined)), /couldn't resolve/, "reply: a Linear ctx with no agent session id throws an honest error");
  n++;
});

console.log(`\n✓ linear-provider-integration: ${n} assertions passed (manifest row, entity-action totality + refusal, reply gate, target, execute + audit, no-anchor throw)`);
