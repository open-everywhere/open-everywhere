// proves: person.opt_out.refused

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-person-opt-out-hooks-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { registerDreamJudge } = await import("../agent/memory/dream/judge.js");
const { workflowSignature, signatureDigest } = await import("../agent/memory/dream/recurrence.js");
const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { SURFACE } = await import("../agent/memory/store.js");
const { restoreSandboxTierToHost } = await import("../agent/hooks/memory.js");
const { tierSandboxDir } = await import("../agent/memory/sandbox-sync.js");
const { turnPersonOptOut } = await import("../agent/memory/opt-out-turn.js");
const learnHook = (await import("../agent/hooks/learn.js")).default;
const { noteTurnBoundary, noteStepDelivery } = await import("../agent/access/task-wake-signal.js");
type DistillInput = import("../agent/memory/dream/judge.js").DistillInput;

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}

const ORG = "acme";
const SILO = "gate-brain";
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "gate", reach: ["slack/T1/C1"], memory: [SILO], mode: "unified" })],
  loadSilos: () => [{ name: SILO, provider: "sqlite" as const }],
  domainsForSurface: () => ["gate"],
});

const distillCalls: DistillInput[] = [];
registerDreamJudge({
  judge: async () => null,
  distill: async (input) => {
    distillCalls.push(input);
    return [{ text: `distilled: ${input.request.slice(0, 80)}`, links: [] }];
  },
});

function wake(body: string): string {
  return renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-06-15T00:40:33Z",
    channel: { id: "C1", type: "channel", memberCount: 3 },
    messages: [{ from: "human", author: "A person", id: "1773691050.563000", sentAt: "2026-06-15T00:40:30Z", trust: "peer", trigger: true, body }],
  });
}

function ctxFor(user: string, sessionId: string, deliveryId: string): never {
  return {
    channel: { kind: "slack", continuationToken: `slack:${sessionId}` },
    session: {
      id: sessionId,
      auth: {
        current: {
          principalId: user,
          principalType: "slack-user",
          attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true", user_id: user, oe_delivery_id: deliveryId },
        },
      },
    },
  } as never;
}

async function deliver(container: InstanceType<typeof FakeEveContext>, ctx: never, message: string): Promise<void> {
  await inEveContext(container, async () => {
    await learnHook.events!["turn.started"]!({} as never, ctx);
    await learnHook.events!["message.received"]!({ data: { message: wake(message) } } as never, ctx);
    await learnHook.events!["turn.completed"]!({} as never, ctx);
  });
}

async function observationsOf(request: string): Promise<number> {
  const rows = await readAudit({ org: ORG, action: "memory.observation" });
  return rows.filter((r) => String(r.detail?.["sigSha"] ?? "") === signatureDigest(workflowSignature(request))).length;
}

await getOperationalStore().setPersonOptOut(ORG, "UALICE", "2026-06-04T13:35:00Z");

console.log("§1 learn");
{
  const ASK = "reconcile the northwind invoices for the quarter and flag the exceptions";
  const container = new FakeEveContext();
  for (let i = 1; i <= 3; i += 1) await deliver(container, ctxFor("UALICE", "s-alice", `d-alice-${i}`), ASK);
  ok((await observationsOf(ASK)) === 0, "an opted-out person's request is never counted");
  ok(distillCalls.length === 0, "…never distilled, though it crossed the threshold three times");
  const refused = await readAudit({ org: ORG, action: "person.opt_out.refused", principalId: "UALICE" });
  ok(refused.length === 3 && refused.every((r) => r.detail?.road === "dream-learn" && r.detail?.act === "memory-write"), "one refusal row per turn names the dream-learn road");
  ok(!JSON.stringify(refused.map((r) => r.detail)).includes("northwind"), "…and never her words");

  const BOB_ASK = "summarise the deploy freeze calendar for the platform team every week";
  const bob = new FakeEveContext();
  for (let i = 1; i <= 3; i += 1) await deliver(bob, ctxFor("UBOB", "s-bob", `d-bob-${i}`), BOB_ASK);
  ok((await observationsOf(BOB_ASK)) === 3, "negative control: a person who did not opt out is counted as before");
  ok(distillCalls.length === 1 && distillCalls[0]!.request.includes("deploy freeze"), "…and distilled at the threshold");
}

console.log("§2 the rolling log");
{
  distillCalls.length = 0;
  const shared = new FakeEveContext();
  const SECRET = "alice is interviewing at another company next tuesday";
  await deliver(shared, ctxFor("UALICE", "s-room", "d-room-a"), SECRET);
  const CAROL_ASK = "draft the weekly status digest for the room and post it on friday";
  for (let i = 1; i <= 3; i += 1) await deliver(shared, ctxFor("UCAROL", "s-room", `d-room-c-${i}`), CAROL_ASK);
  ok(distillCalls.length === 1, "fixture: Carol's repeated request reaches the distiller in the shared session");
  ok(!(distillCalls[0]!.messages ?? []).some((m) => m.includes("interviewing")), "🔴 the distiller reads none of Alice's words from earlier in the same session");
  ok((distillCalls[0]!.messages ?? []).some((m) => m.includes("weekly status digest")), "…while Carol's own words are there (the log was not simply emptied)");
}

console.log("§2b the delivery-change return");
{
  distillCalls.length = 0;
  const shared = new FakeEveContext();
  const MARKER = "frank mentioned the zebra-quartz migration plan in passing";
  const swapCtx = { ...(ctxFor("UFRANK", "s-swap", "d-swap-a") as object), session: { ...((ctxFor("UFRANK", "s-swap", "d-swap-a") as { session: object }).session), turn: { id: "turn_swap" } } } as never;
  await inEveContext(shared, async () => {
    await learnHook.events!["turn.started"]!({} as never, swapCtx);
    await learnHook.events!["message.received"]!({ data: { message: wake(MARKER) } } as never, swapCtx);
    noteTurnBoundary("turn_swap", "stamp-a");
    noteStepDelivery("turn_swap", "stamp-b");
    await learnHook.events!["turn.completed"]!({} as never, swapCtx);
  });
  const CAROL_ASK = "collect the open incident follow-ups and chase each owner on monday";
  for (let i = 1; i <= 3; i += 1) await deliver(shared, ctxFor("UCAROL", "s-swap", `d-swap-c-${i}`), CAROL_ASK);
  ok(distillCalls.length === 1, "fixture: Carol's repeated request reaches the distiller after the swapped turn");
  ok(!(distillCalls[0]!.messages ?? []).some((m) => m.includes("zebra-quartz")), "🔴 the swapped turn's words are not in the rolling log a later turn distils");
  ok((distillCalls[0]!.messages ?? []).some((m) => m.includes("incident follow-ups")), "…while Carol's own words are (positive control)");
}

console.log("§3 the sandbox restore");
{
  const dir = tierSandboxDir(SURFACE);
  const files = new Map<string, string>([
    [`${dir}/MEMORY.md`, "# m\n\n- host line\n- REFUSED line\n"],
    [`${dir}/new-topic.md`, "- refused topic\n"],
  ]);
  const commands: string[] = [];
  const sandbox = {
    writeTextFile: async ({ path, content }: { path: string; content: string }) => void files.set(path, content),
    run: async ({ command }: { command: string }) => {
      commands.push(command);
      for (const m of command.matchAll(/'([^']+)'/g)) files.delete(m[1]!);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const host = { "MEMORY.md": "# m\n\n- host line\n" };
  const fromSandbox = { "MEMORY.md": "# m\n\n- host line\n- REFUSED line\n", "new-topic.md": "- refused topic\n" };
  await restoreSandboxTierToHost(sandbox as never, SURFACE, host, fromSandbox);
  const mem = files.get(`${dir}/MEMORY.md`) ?? "";
  ok(mem === host["MEMORY.md"], "the refused line is gone from the sandbox — the next persist has nothing to merge in");
  ok(![...files.keys()].some((k) => k.endsWith("/new-topic.md")), "a file the refused turn created is removed");
  ok(commands.length === 1 && !commands[0]!.includes("MEMORY.md"), "the host's own file is rewritten, never removed");
  await restoreSandboxTierToHost({ writeTextFile: async () => Promise.reject(new Error("sandbox gone")), run: async () => ({}) } as never, SURFACE, host, fromSandbox);
  ok(true, "a failing sandbox is logged, never thrown");
}

console.log("§4 the per-turn answer");
{
  const container = new FakeEveContext();
  await getOperationalStore().setPersonOptOut(ORG, "UDAN", "2026-06-04T13:35:00Z");
  await inEveContext(container, async () => {
    ok((await turnPersonOptOut(ORG, "UDAN", "turn_1")).optedOut === true, "the first ask reads the store");
    await getOperationalStore().clearPersonOptOut(ORG, "UDAN");
    ok((await turnPersonOptOut(ORG, "UDAN", "turn_1")).optedOut === true, "🔴 a later ask in the SAME turn gets the first answer, though the store changed");
    ok((await turnPersonOptOut(ORG, "UDAN", "turn_2")).optedOut === false, "a different turn reads again");
    ok((await turnPersonOptOut(ORG, "UEVE", "turn_2")).optedOut === false, "a different person in the turn reads their own row");
  });
  ok((await turnPersonOptOut(ORG, "UALICE", "turn_9")).optedOut === true, "outside an eve context it is a plain read");
}

removeTempDir(tmp);
console.log(`✓ person-opt-out-hooks: ${n} assertions`);
