// proves: AP-MOD-core-credentials-config-pr

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-learn-hook-edge-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();
await import("./_register-test-config.js");

const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { workflowSignature, signatureDigest } = await import("../agent/memory/dream/recurrence.js");
const { SCHEDULE_APP_AUTHENTICATOR, SCHEDULE_APP_PRINCIPAL_ID, SCHEDULE_APP_PRINCIPAL_TYPE } = await import("../agent/identity/binding.js");
const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
const learnHook = (await import("../agent/hooks/learn.js")).default;

function wake(body: string): string {
  return renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-04-18T05:10:33Z",
    channel: { id: "C1", type: "channel", memberCount: 3 },
    messages: [{ from: "human", author: "Rowan Hale", id: "1774288247.563000", sentAt: "2026-04-18T05:10:30Z", trust: "peer", trigger: true, body }],
  });
}

const ORG = "acme";
const SLACK_ATTRS = { team_id: "T1", channel_id: "C1", channel_type: "channel" };

async function observedDigests(): Promise<string[]> {
  const rows = await readAudit({ org: ORG, action: "memory.observation" });
  return rows.map((r) => String(r.detail?.["sigSha"] ?? ""));
}

async function observedDetails(): Promise<string[]> {
  const rows = await readAudit({ org: ORG, action: "memory.observation" });
  return rows.map((r) => JSON.stringify(r.detail ?? {}));
}

async function observed(request: string): Promise<boolean> {
  const sig = workflowSignature(request);
  ok(sig.length > 0, `fixture: "${request}" produces a non-empty signature (otherwise the check below passes for free)`);
  return (await observedDigests()).includes(signatureDigest(sig));
}

function seatCtx(sessionId: string, deliveryId = `delivery-${sessionId}`): never {
  return {
    channel: { kind: "slack", continuationToken: `slack:${sessionId}` },
    session: {
      id: sessionId,
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { ...SLACK_ATTRS, oe_delivery_id: deliveryId } } },
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

{
  const request = "reconcile the quarterly ledger for northwind";
  await deliver(new FakeEveContext(), seatCtx("sess-seat"), request);
  ok(await observed(request), "edge: a SEAT's turn records the observation — the cycle no longer needs a session end, which never comes");
}

{
  const container = new FakeEveContext();
  const ctx = seatCtx("sess-multi");
  const first = "provision the warehouse cluster in frankfurt";
  const second = "summarise yesterday's payment reconciliation exceptions";
  const third = "archive the deprecated onboarding runbooks";

  await deliver(container, ctx, first);
  await deliver(container, ctx, second);
  await deliver(container, ctx, third);

  const keys = await observedDigests();
  const countOf = (req: string) => keys.filter((k) => k === signatureDigest(workflowSignature(req))).length;
  ok(countOf(first) === 1, "per-turn: the session's FIRST request is observed exactly ONCE across three turns — not once per turn");
  ok(countOf(second) === 1, "per-turn: the second turn observes its OWN request");
  ok(countOf(third) === 1, "per-turn: and the third observes its own");
}

{
  const container = new FakeEveContext();
  const ctx = seatCtx("sess-empty");
  const only = "rotate the staging database credentials";
  await deliver(container, ctx, only);
  const before = (await observedDigests()).length;
  await inEveContext(container, async () => {
    await learnHook.events!["turn.started"]!({} as never, ctx);
    await learnHook.events!["turn.completed"]!({} as never, ctx);
  });
  ok((await observedDigests()).length === before, "per-turn: a turn carrying NO user message observes nothing — the capture is reset, never inherited");
}

{
  const brief = "fetch the octocat readme and report back to the caller";
  const childCtx = {
    channel: { kind: "slack", continuationToken: "slack:sess-child" },
    session: {
      id: "sess-child",
      parent: { sessionId: "sess-seat" },
      auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { ...SLACK_ATTRS } } },
    },
  } as never;
  await deliver(new FakeEveContext(), childCtx, brief);
  const sig = workflowSignature(brief);
  ok(sig.length > 0, "fixture: the brief produces a non-empty signature");
  ok(!(await observedDigests()).includes(signatureDigest(sig)), "skip: a delegated CHILD's brief is NOT fingerprinted — the cycle learns from humans, not from the agent's notes to itself");
}

{
  const cronPrompt = "gather the overnight settlement numbers and post the digest";
  const fireCtx = {
    channel: { kind: "slack", continuationToken: "slack:sess-fire" },
    session: {
      id: "sess-fire",
      auth: {
        current: {
          attributes: { ...SLACK_ATTRS, [ROUTINE_MARKER.id]: "r-1", [ROUTINE_MARKER.surface]: "slack/T1/C1", [ROUTINE_MARKER.org]: ORG },
          authenticator: SCHEDULE_APP_AUTHENTICATOR,
          principalId: SCHEDULE_APP_PRINCIPAL_ID,
          principalType: SCHEDULE_APP_PRINCIPAL_TYPE,
        },
      },
    },
  } as never;
  const container = new FakeEveContext();
  await deliver(container, fireCtx, cronPrompt);
  await deliver(container, fireCtx, cronPrompt);
  await deliver(container, fireCtx, cronPrompt);
  const sig = workflowSignature(cronPrompt);
  ok(sig.length > 0, "fixture: the cron prompt produces a non-empty signature");
  ok(!(await observedDigests()).includes(signatureDigest(sig)), "skip: a routine FIRE's prompt is NOT fingerprinted, even after three fires — a cron is not a recurring human workflow");
}

{
  const container = new FakeEveContext();
  const request = "escalate the stuck settlement batch to the payments desk";
  const ctx = seatCtx("sess-replay", "delivery-replay-1");

  for (let i = 0; i < 5; i++) await deliver(container, ctx, request);

  const sig = workflowSignature(request);
  ok(sig.length > 0, "fixture: the request produces a non-empty signature");
  const counted = (await observedDigests()).filter((k) => k === signatureDigest(sig)).length;
  ok(counted === 1, `replay: five re-executions of ONE delivery record ONE observation (got ${counted}) — a single message can never cross the recurrence threshold by itself`);

  await deliver(container, seatCtx("sess-replay", "delivery-replay-2"), request);
  const after = (await observedDigests()).filter((k) => k === signatureDigest(sig)).length;
  ok(after === 2, `replay: the SAME words on a NEW delivery DO count (got ${after}) — the dedupe separates requests, it does not silence the ledger`);
}

{
  const body = "escalate the pricing anomaly in the frankfurt tariff table";
  const rendered = wake(body);
  ok(rendered.includes("<wake") && rendered.includes('trigger="true"'), "fixture: the renderer really produces an envelope around the body");
  const bodySig = workflowSignature(body);
  const envelopeSig = workflowSignature(rendered);
  ok(bodySig !== envelopeSig && envelopeSig.length > 0, "fixture: the envelope and the body really fingerprint differently (else ① proves nothing)");

  await deliver(new FakeEveContext(), seatCtx("sess-envelope"), body);
  const keys = await observedDigests();
  ok(keys.includes(signatureDigest(bodySig)), "envelope: the AUTHOR's body is what got fingerprinted");
  ok(!keys.includes(signatureDigest(envelopeSig)), "envelope: the rendered ENVELOPE's boilerplate signature is NOT recorded — the body is parsed out before the fingerprint");

  const details = await observedDetails();
  ok(details.length > 0, "envelope: there are rows to check (otherwise the next line passes for free)");
  const leaked = details.filter((d) => ["escalate", "frankfurt", "reconcile", "quarterly", "anomaly", "northwind"].some((w) => d.includes(w)));
  ok(leaked.length === 0, `OPE-924: no observation row's detail carries message-derived words (found: ${leaked.join(" | ")})`);

  const notification = "Background task task_19b02bf3ac581355a2f4fcf5 (agent) is completed. Use task_peek to read its output.";
  const container = new FakeEveContext();
  const ctx = seatCtx("sess-notify");
  await inEveContext(container, async () => {
    await learnHook.events!["turn.started"]!({} as never, ctx);
    await learnHook.events!["message.received"]!({ data: { message: notification } } as never, ctx);
    await learnHook.events!["turn.completed"]!({} as never, ctx);
  });
  const sig = workflowSignature(notification);
  ok(sig.length > 0, "fixture: the task notification produces a non-empty signature");
  ok(!(await observedDigests()).includes(signatureDigest(sig)), "envelope: eve's own task-settlement notification is NOT fingerprinted — it carries no envelope, so no human authored it");
}

{
  const brief = "fetch the octocat readme and report back to the caller";
  await deliver(new FakeEveContext(), seatCtx("sess-control"), brief);
  ok(await observed(brief), "control: the SAME words spoken by a human in a seat ARE recorded — so the two skips above measure the context, not a dead reader");
}

{
  const { registerConfig, getConfig } = await import("../agent/access/config.js");
  const { registerConfigPrProvider } = await import("../agent/credentials/config-pr.js");
  const { SKILL_PROPOSAL_PR_ACTION } = await import("../agent/memory/dream/skill-proposal-pr.js");

  const accessRequests = { configRepo: "acme/config", configBase: "main", baseBundles: () => [], baseBindings: () => [] };
  registerConfig({ ...getConfig(), loadAccessRequests: () => accessRequests });

  const opened: { head: string; base: string; title: string }[] = [];
  const written: { path: string; branch: string }[] = [];
  registerConfigPrProvider({
    resolveWriteToken: async () => "fake-token",
    committer: () => ({ name: "open-everywhere[bot]", email: "bot@example.invalid" }),
    getBranchSha: async (a) => (a.branch === "main" ? "basesha" : null),
    ensureBranch: async () => {},
    getFile: async () => null,
    putFile: async (a) => {
      written.push({ path: a.path, branch: a.branch });
    },
    openOrReopenPr: async (a) => {
      opened.push({ head: a.head, base: a.base, title: a.title });
      return { url: "https://example.invalid/pull/99", number: 99, updated: false, reopened: false };
    },
  });

  const request = "rebuild the search index for the docs site";
  const container = new FakeEveContext();
  for (let i = 1; i <= 3; i += 1) {
    await deliver(container, seatCtx("sess-proposal", `delivery-proposal-${i}`), request);
  }

  ok(opened.length === 1, "🔴 REACHABILITY: three deliveries of one request cross the recurrence gate and the HOOK opens a proposal pull request");
  ok(opened[0]!.base === "main" && opened[0]!.head.startsWith("skill-proposal/"), "…head is the proposal branch, base is the config repo's base branch");
  ok(written.length === 1 && written[0]!.path.startsWith(".agents/skills/"), "…and exactly one skill file is written, where a repo skill is discovered");
  ok(written.every((w) => w.branch !== "main"), "🔴 …and nothing was written to the base branch, on the real hook path too");

  const rows = await readAudit({ org: ORG, action: SKILL_PROPOSAL_PR_ACTION });
  ok(rows.length === 1 && rows[0]!.detail?.["pr"] === 99, "…the attempt left its audit row, which is what a later crossing reads corrections back from");
}

{
  const { noteTurnBoundary, noteStepDelivery } = await import("../agent/access/task-wake-signal.js");
  const turnCtx = (turnId: string, principalId: string, deliveryId: string): never =>
    ({
      channel: { kind: "slack", continuationToken: "slack:sess-swap" },
      session: {
        id: "sess-swap",
        turn: { id: turnId, sequence: 1 },
        auth: { current: { principalId, principalType: "slack-user", attributes: { ...SLACK_ATTRS, oe_delivery_id: deliveryId } } },
      },
    }) as never;
  const runTurn = async (container: InstanceType<typeof FakeEveContext>, turnId: string, request: string, swapTo?: string): Promise<void> => {
    const start = turnCtx(turnId, "U_A", `dlv-${turnId}-A`);
    const end = swapTo === undefined ? start : turnCtx(turnId, swapTo, `dlv-${turnId}-B`);
    await inEveContext(container, async () => {
      noteTurnBoundary(turnId, `dlv-${turnId}-A`);
      await learnHook.events!["turn.started"]!({} as never, start);
      await learnHook.events!["message.received"]!({ data: { message: wake(request) } } as never, start);
      if (swapTo !== undefined) noteStepDelivery(turnId, `dlv-${turnId}-B`);
      await learnHook.events!["turn.completed"]!({} as never, end);
    });
  };

  const kept = "migrate the billing exports to the new warehouse";
  await runTurn(new FakeEveContext(), "turn_swap_ctl", kept);
  ok(await observed(kept), "swap control: a turn with ONE delivery and a readable turn id is still observed");

  const swapped = "decommission the legacy invoicing queue in dublin";
  await runTurn(new FakeEveContext(), "turn_swap", swapped, "U_B");
  ok(!(await observed(swapped)), "🔴 swap: a turn whose bag changed to ANOTHER principal mid-turn learns NOTHING — A's words are never filed under B's bag");
}

await removeTempDir(tmp);
console.log(`✓ learn-hook-edge: ${passed} assertions passed`);
