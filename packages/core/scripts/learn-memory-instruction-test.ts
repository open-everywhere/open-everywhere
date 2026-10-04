import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
import { removeTempDir } from "./_temp-dir.js";

let passed = 0;
const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-learn-memory-instruction-"));
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: "acme" });

const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
registerSlackFixtureMapper();

const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { providerById } = await import("../agent/memory/provider.js");
const { siloTier } = await import("../agent/memory/store.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { workflowSignature, signatureDigest, inMemoryLedger } = await import("../agent/memory/dream/recurrence.js");
const { registerDreamJudge } = await import("../agent/memory/dream/judge.js");
const { isMemoryInstruction, learnFromSession, safeDistill } = await import("../agent/memory/dream/learn.js");
const { isRememberAsk } = await import("../agent/memory/write-intent.js");
const { renderWakeEnvelope } = await import("../agent/channels/wake-envelope.js");
const learnHook = (await import("../agent/hooks/learn.js")).default;

type DistillInput = import("../agent/memory/dream/judge.js").DistillInput;

const ORG = "acme";
const SILO = "gate-brain";
const SLACK_ATTRS = {
  team_id: "T1",
  channel_id: "C1",
  channel_type: "channel",
  is_private: "false",
  is_ext_shared: "false",
  trust_checked: "true",
  user_id: "U7",
};
const silo = { name: SILO, provider: "sqlite" as const };
const partition = {
  org: ORG,
  platform: "slack",
  workspace: "T1",
  surface: "C1",
  workspaceKey: "slack/T1",
  surfaceKey: "slack/T1/C1",
  key: "slack/T1/C1",
} as import("../agent/memory/partition.js").Partition;

registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [defineDomain({ name: "gate", reach: ["slack/T1/C1"], memory: [SILO], mode: "unified" })],
  loadSilos: () => [silo],
  domainsForSurface: () => ["gate"],
});

const distillCalls: DistillInput[] = [];
function echoingDistill(input: DistillInput): { text: string; links: string[] }[] {
  distillCalls.push(input);
  return [{ text: `distilled: ${input.request.slice(0, 120)}`, links: ["invoices"] }];
}
registerDreamJudge({ judge: async () => null, distill: async (input) => echoingDistill(input) });

const PURGE_ASK =
  "permanently erase from memory every stored fact that states an OPE121 canary code — every one of them, whatever code each names, including any note recording which code was verified. They are stale test data from earlier runs of this check and must not persist.";
const ORDINARY_ASK = "reconcile the northwind invoices for the quarter and flag the exceptions";

function wake(body: string): string {
  return renderWakeEnvelope({
    reason: "channel-activity",
    currentTime: "2026-05-28T11:20:33Z",
    channel: { id: "C1", type: "channel", memberCount: 3 },
    messages: [{ from: "human", author: "Rowan Hale", id: "1775020581.563000", sentAt: "2026-05-28T11:20:30Z", trust: "peer", trigger: true, body }],
  });
}

function seatCtx(sessionId: string, deliveryId: string): never {
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

async function deliverThrice(request: string, sessionId: string): Promise<void> {
  const container = new FakeEveContext();
  for (let i = 1; i <= 3; i += 1) {
    await deliver(container, seatCtx(sessionId, `delivery-${sessionId}-${i}`), request);
  }
}

async function observationsOf(request: string): Promise<number> {
  const sig = workflowSignature(request);
  ok(sig.length > 0, `fixture: "${request.slice(0, 40)}…" produces a non-empty signature (otherwise the counts below pass for free)`);
  const rows = await readAudit({ org: ORG, action: "memory.observation" });
  return rows.filter((r) => String(r.detail?.["sigSha"] ?? "") === signatureDigest(sig)).length;
}

async function learnRows(): Promise<readonly { detail?: Record<string, unknown> }[]> {
  return await readAudit({ org: ORG, action: "memory.learn" });
}

async function recurringFile(): Promise<string> {
  const files = await providerById("sqlite").readTier(partition, siloTier(SILO), silo);
  return files["RECURRING.md"] ?? "";
}

{
  await deliverThrice(PURGE_ASK, "sess-purge");

  ok((await observationsOf(PURGE_ASK)) === 0, "🔴 the road records NO recurrence observation for an erase-from-memory ask — it never starts counting it as a workflow");
  ok((await learnRows()).length === 0, "🔴 …and writes no `memory.learn` row, so nothing was distilled (distilled=0)");
  ok(distillCalls.length === 0, "🔴 …and the judge is never asked to distill the ask");
  const body = await recurringFile();
  ok(!body.includes("OPE121") && !body.includes("canary"), "🔴 …and no RECURRING bullet names the subject the person asked to erase");
  ok(!body.includes("must not persist"), "🔴 …and none re-states the erasure as a standing rule");
}

{
  await deliverThrice(ORDINARY_ASK, "sess-ordinary");

  ok((await observationsOf(ORDINARY_ASK)) === 3, "control: three deliveries of an ordinary request record three observations");
  const rows = await learnRows();
  ok(rows.length === 1, "control: the crossing writes exactly one `memory.learn` row");
  ok(rows[0]!.detail?.["distilled"] === 1, "control: that row counts the distilled fact — so `distilled=0` above measures the skip, not a road that never distills");
  ok(distillCalls.length === 1, "control: the judge IS asked to distill an ordinary request");
  ok((await recurringFile()).includes("distilled: reconcile the northwind invoices"), "control: the distilled fact really lands in RECURRING.md, carrying the words of the request it came from — so the missing bullet above is a refusal, not an unwritable silo");
}

{
  const ledger = inMemoryLedger();
  const result = await learnFromSession(SILO, { request: PURGE_ASK, dedupeKey: "d1" }, ledger, { enrichThreshold: 1, skillThreshold: 1 });
  ok(result.skipped === "memory-instruction", "the decision names WHY it declined, which is what the hook logs");
  ok(result.signature === null && result.count === 0, "…the turn gets no fingerprint and no count");
  ok(!result.enrich && result.skillProposal === null, "…so even at a threshold of 1 there is no enrichment and no SKILL.md draft");

  const control = await learnFromSession(SILO, { request: ORDINARY_ASK, dedupeKey: "d2" }, ledger, { enrichThreshold: 1, skillThreshold: 1 });
  ok(control.skipped === null && control.enrich && control.skillProposal !== null, "control: at the same thresholds an ordinary request crosses on its first delivery");
  ok((control.skillProposal?.after ?? "").includes("northwind"), "control: and the draft it produces quotes its OWN request — asserted positively, so the check cannot pass on an empty draft");
}

{
  const INSTRUCTIONS = [
    PURGE_ASK,
    "permanently erase the stored fact about the deploy token colour obsidian-77 from memory — it was test data and must not persist",
    "permanently erase anything you stored about e2e-20260921 from memory — it was test data and must not persist",
    "delete that from your memory please",
    "purge your notes about the mascot",
    "wipe the brain and start again",
    "every stored fact about the canary must be erased",
    "forget that",
    "forget everything you know about the mascot",
    "forget about the canary code",
    "don't remember this",
    "never store that",
    "stop saving what I tell you in this channel",
    "nothing about the canary codes must persist in your memory",
    "please permanently erase\nfrom memory every stored fact about the OPE121 canary codes",
    "remember that stored facts about a candidate are deleted after 30 days",
  ];
  for (const text of INSTRUCTIONS) ok(isMemoryInstruction(text), `an instruction about memory is recognised: "${text.slice(0, 60)}"`);

  const FACTS = [
    "remember this for the team: the OPE121 canary code is obsidian-12345",
    "don't forget the door code is 1234",
    "never forget that the launch is on the 30th",
    "we never store card numbers in the ledger service",
    "remember that the cache must not persist across restarts",
    "never ever forget that the launch is on the 30th",
    "the API key must not be stored in the repo — read it from the vault at boot",
    "the cache must not persist across restarts, that is what makes the probe honest",
    "delete the stale rows from the audit table before you run the report",
    "delete the meeting notes from the shared drive when the quarter closes",
    "reconcile the northwind invoices for the quarter and flag the exceptions",
    "summarise yesterday's payment reconciliation exceptions",
  ];
  for (const text of FACTS) ok(!isMemoryInstruction(text), `a fact FOR memory is NOT an instruction about it: "${text.slice(0, 60)}"`);

  ok(!isMemoryInstruction(undefined) && !isMemoryInstruction(""), "an absent or empty request is not an instruction about memory");

  for (const text of ["remember this for the team: the OPE121 canary code is obsidian-12345", "don't forget the door code is 1234", "can you remember the handle for the new vendor"]) {
    ok(isRememberAsk(text) && !isMemoryInstruction(text), `a remember-ask that carries a fact stays learnable: "${text.slice(0, 50)}"`);
  }
}

{
  const before = distillCalls.length;
  const asPurge = await safeDistill({ judge: async () => null, distill: async (i) => { distillCalls.push(i); return [{ text: "should never happen", links: [] }]; } }, {
    scope: SILO,
    request: PURGE_ASK,
    messages: [PURGE_ASK],
    signature: "x",
    count: 3,
  });
  ok(asPurge === null, "🔴 safeDistill answers null for a request that is an instruction about memory");
  ok(distillCalls.length === before, "🔴 …without calling the judge at all");

  const seen: DistillInput[] = [];
  const spy = { judge: async () => null, distill: async (i: DistillInput) => { seen.push(i); return [{ text: "ok", links: [] }]; } };
  const mixed = await safeDistill(spy, { scope: SILO, request: ORDINARY_ASK, messages: [ORDINARY_ASK, PURGE_ASK, "forget that"], signature: "y", count: 3 });
  ok(mixed?.length === 1, "an ordinary request still distills");
  ok(seen.length === 1 && (seen[0]!.messages ?? []).length === 1, "🔴 …and the judge is handed ONLY the messages that are facts for memory");
  ok(!JSON.stringify(seen[0]!.messages ?? []).includes("OPE121"), "🔴 …so the erase ask spoken in the same session never reaches the distiller");

  const clean = await safeDistill(spy, { scope: SILO, request: ORDINARY_ASK, messages: [ORDINARY_ASK, "and post the summary to the finance channel"], signature: "z", count: 3 });
  ok(clean?.length === 1 && (seen[1]!.messages ?? []).length === 2, "control: a session with no instruction about memory reaches the judge with EVERY message — the filter drops nothing else");
}

await removeTempDir(tmp);
console.log(`\n✓ learn-memory-instruction: ${passed} assertions passed (the learn road declines a turn whose request is an instruction about memory; an ordinary request is unchanged)\n`);
