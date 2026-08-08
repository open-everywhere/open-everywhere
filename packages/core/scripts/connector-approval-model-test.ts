process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_PLATFORM = "slack";
delete process.env.OE_ORG;

import { classifyConnectorOpTier, restMethodTier } from "../agent/access/consequence.js";
import { sessionGrantKind, connectorSessionKind } from "../agent/approvals/session-grant.js";
import { connectorOpApproval } from "../agent/connections/connector-auth.js";
import type { ExecutorApprovalContext, ExecutorOpArgs } from "../agent/connections/executor-approval-bridge.js";

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const { surfaceExecutorApproval, EXECUTOR_OP_KIND } = await import("../agent/connections/executor-approval-bridge.js");
const { requestApproval, resolveApprovalClick } = await import("../agent/approvals/flow.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { readAudit } = await import("../agent/audit/audit.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const op of ["notion__search", "notion__get_page", "linear__list_issues", "x__fetch", "y__retrieve", "z__query"]) {
  ok(classifyConnectorOpTier(op) === "read", `read op ${op} → read`);
}
for (const op of ["notion__create_page", "notion__update_page", "notion__append_block", "linear__create_issue", "x__post_message", "y__set_property", "z__archive_page"]) {
  ok(classifyConnectorOpTier(op) === "write", `write op ${op} → write`);
}
for (const op of ["notion__delete_page", "linear__remove_label", "gh__destroy_repo", "x__drop_table", "y__purge_cache", "z__trash_doc", "a__erase_row", "b__wipe_db"]) {
  ok(classifyConnectorOpTier(op) === "destructive", `destructive op ${op} → destructive`);
}
ok(classifyConnectorOpTier("notion__frobnicate_widget") === "destructive", "unknown verb → destructive (fail-closed, never session-skippable)");
ok(classifyConnectorOpTier("notion__") === "destructive", "empty op → destructive (fail-closed)");
ok(classifyConnectorOpTier("notion__unarchive_page") === "write", "unarchive is reversible → write, not destructive");
ok(classifyConnectorOpTier("notion__get_or_create_entity") === "write", "compound get_or_create → write (any write token escalates past a read head)");
ok(classifyConnectorOpTier("slack__check_and_post_message") === "write", "compound check_and_post → write");
ok(classifyConnectorOpTier("linear__list_or_create_labels") === "write", "compound list_or_create → write");
ok(classifyConnectorOpTier("x__get_or_delete_row") === "destructive", "compound with a destructive token → destructive outright");
ok(classifyConnectorOpTier("x__get_delete_marker") === "destructive", "noun-collision over-gates in the SAFE direction (delete token wins even as a noun)");
ok(classifyConnectorOpTier("notion__get_page") === "read", "plain read with noun tokens stays read (unrecognised tokens don't drag to destructive when a read verb is present)");

ok(restMethodTier("GET") === "read", "GET → read");
ok(restMethodTier("head") === "read", "HEAD (case-insensitive) → read");
ok(restMethodTier("OPTIONS") === "read", "OPTIONS → read");
ok(restMethodTier("POST") === "write", "POST → write");
ok(restMethodTier("PUT") === "write", "PUT → write");
ok(restMethodTier(" patch ") === "write", "PATCH (trimmed/cased) → write");
ok(restMethodTier("DELETE") === "destructive", "DELETE → destructive");
ok(restMethodTier("TRACE") === "destructive", "an unknown method → destructive (fail-closed)");
ok(restMethodTier("") === "destructive", "an empty method → destructive (fail-closed)");

ok(connectorSessionKind("notion") === "connector.op:notion", "connectorSessionKind is per-connector");
ok(sessionGrantKind({ kind: "pr.open", argsJson: "{}" }) === "pr.open", "pr.open is always grantable → memo kind pr.open");
ok(
  sessionGrantKind({ kind: EXECUTOR_OP_KIND, argsJson: JSON.stringify({ tier: "write", connector: "notion" }) }) === "connector.op:notion",
  "a WRITE connector op is grantable under connector.op:<connector>",
);
ok(sessionGrantKind({ kind: EXECUTOR_OP_KIND, argsJson: JSON.stringify({ tier: "destructive", connector: "notion" }) }) === null, "a DESTRUCTIVE connector op is NOT grantable (per-call)");
ok(sessionGrantKind({ kind: EXECUTOR_OP_KIND, argsJson: JSON.stringify({ tier: "write", tainted: true, connector: "notion" }) }) === null, "a TAINTED write is NOT grantable (fresh card)");
ok(sessionGrantKind({ kind: EXECUTOR_OP_KIND, argsJson: JSON.stringify({ connector: "notion" }) }) === null, "a connector op with no frozen tier is NOT grantable (fail-closed)");
ok(sessionGrantKind({ kind: EXECUTOR_OP_KIND, argsJson: "not json" }) === null, "unparseable frozen args → NOT grantable");
ok(sessionGrantKind({ kind: "create_skill", argsJson: "{}" }) === null, "an injection gate (create_skill) is NOT grantable");
ok(sessionGrantKind({ kind: "spend.set", argsJson: "{}" }) === null, "an admin gate (spend.set) is NOT grantable");

{
  const approve = connectorOpApproval();
  ok(approve({ toolName: "notion__search", approvedTools: new Set<string>() } as never) === "not-applicable", "read never prompts");
  const approvedWrite = new Set<string>(["notion__create_page"]);
  ok(approve({ toolName: "notion__create_page", approvedTools: approvedWrite } as never) === "not-applicable", "an already-approved WRITE is silenced (once-per-op)");
  const approvedDelete = new Set<string>(["notion__delete_page"]);
  ok(approve({ toolName: "notion__delete_page", approvedTools: approvedDelete } as never) === "user-approval", "a DESTRUCTIVE op prompts PER CALL even when already approved (never honours the memo)");
  ok(approve({ toolName: "notion__delete_page", approvedTools: new Set<string>() } as never) === "user-approval", "an unapproved destructive op prompts");
}

const ORG = "default";
function baseContext(over: Partial<ExecutorApprovalContext> = {}): ExecutorApprovalContext {
  return {
    org: ORG,
    scopeKey: "slack/T1/C1",
    connector: "notion",
    op: "notion_create_page",
    callArgs: { title: "Q3" },
    executionId: "exec_1",
    requestedBy: "U_REQ",
    channelId: "C1",
    threadTs: null,
    postedTo: "slack/T1/C1",
    domain: null,
    platform: "slack",
    tier: "write",
    tainted: false,
    sessionId: "win-A",
    ...over,
  };
}
function mintSpy(): { fn: typeof requestApproval; count: () => number } {
  let count = 0;
  const fn = (async () => {
    count++;
    return { id: `pend-${count}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  }) as unknown as typeof requestApproval;
  return { fn, count: () => count };
}
function resumeSpy(line = "connector write `notion_create_page` on `notion` approved by <@U_G> and completed."): {
  fn: (args: ExecutorOpArgs, decidedBy: string) => Promise<string>;
  calls: () => number;
  lastDecidedBy: () => string | undefined;
} {
  let calls = 0;
  let lastDecidedBy: string | undefined;
  const fn = async (_args: ExecutorOpArgs, decidedBy: string) => {
    calls++;
    lastDecidedBy = decidedBy;
    return line;
  };
  return { fn: fn as never, calls: () => calls, lastDecidedBy: () => lastDecidedBy };
}
async function seedGrant(sessionId: string, connector: string, grantedBy: string): Promise<void> {
  const now = new Date();
  await getOperationalStore().setSessionApproval({
    org: ORG,
    sessionId,
    kind: connectorSessionKind(connector),
    grantedBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
  });
}

{
  await seedGrant("win-A", "notion", "U_GRANTER");
  const mint = mintSpy();
  const resume = resumeSpy();
  const res = await surfaceExecutorApproval(baseContext({ sessionId: "win-A" }), { requestApproval: mint.fn, resume: resume.fn as never });
  ok(mint.count() === 0, "a session-approved WRITE mints NO card");
  ok(resume.calls() === 1, "a session-approved WRITE resumes the paused fiber exactly once");
  ok(resume.lastDecidedBy() === "U_GRANTER", "the resume is attributed to the GRANTING member, not the requester");
  const sc = (res as { structuredContent?: { status?: string; sessionApproved?: boolean } }).structuredContent;
  ok(sc?.status === "completed" && sc?.sessionApproved === true, "the model gets a completed+sessionApproved envelope");
  const rows = await readAudit({ org: ORG, action: "connector.op.session_skip" });
  ok(rows.length === 1 && rows[0].detail?.connector === "notion" && rows[0].detail?.grantedBy === "U_GRANTER", "a connector.op.session_skip audit row lands (ids only)");
}

{
  await seedGrant("win-A", "notion", "U_GRANTER");
  const mint = mintSpy();
  const resume = resumeSpy();
  const res = await surfaceExecutorApproval(
    baseContext({ sessionId: "win-A", op: "notion_delete_page", tier: "destructive", callArgs: { id: "pg1" } }),
    { requestApproval: mint.fn, resume: resume.fn as never },
  );
  ok(resume.calls() === 0, "a DESTRUCTIVE op is NEVER session-skipped, even with a live grant");
  ok(mint.count() === 1, "a DESTRUCTIVE op ALWAYS mints a fresh per-call card");
  const sc = (res as { structuredContent?: { status?: string } }).structuredContent;
  ok(sc?.status === "awaiting_approval", "the destructive op returns awaiting-approval (a card was posted)");
  const rows = await readAudit({ org: ORG, action: "connector.op.destructive_card" });
  ok(rows.length === 1 && rows[0].detail?.op === "notion_delete_page", "a connector.op.destructive_card audit row marks the per-call destructive gate");
}

{
  await seedGrant("win-A", "notion", "U_GRANTER");
  const mint = mintSpy();
  const resume = resumeSpy();
  await surfaceExecutorApproval(baseContext({ sessionId: "win-A", tainted: true }), { requestApproval: mint.fn, resume: resume.fn as never });
  ok(resume.calls() === 0 && mint.count() === 1, "a TAINTED write is never session-skipped — a fresh card is minted");
}

{
  await seedGrant("win-A", "notion", "U_GRANTER");
  const mint = mintSpy();
  const resume = resumeSpy();
  await surfaceExecutorApproval(baseContext({ sessionId: "win-B" }), { requestApproval: mint.fn, resume: resume.fn as never });
  ok(resume.calls() === 0 && mint.count() === 1, "a rotated session (win-B) misses the win-A grant → fresh card");
  const mint2 = mintSpy();
  const resume2 = resumeSpy();
  await surfaceExecutorApproval(baseContext({ sessionId: null }), { requestApproval: mint2.fn, resume: resume2.fn as never });
  ok(resume2.calls() === 0 && mint2.count() === 1, "no session identity → fresh card (never skips)");
}

{
  const { registerExecutorTransportClient, resetExecutorTransportClient } = await import("../agent/connections/executor-transport.js");
  let resumeCount = 0;
  registerExecutorTransportClient({
    async execute() {
      return {};
    },
    async resume() {
      resumeCount++;
      return { structuredContent: { status: "completed" } };
    },
  });
  const store = getOperationalStore();
  const postCard = async () => "ts-1";

  const writeArgs: ExecutorOpArgs = {
    org: ORG,
    scopeKey: "slack/T1/C1",
    connector: "notion",
    op: "notion_create_page",
    executionId: "exec_w",
    callArgs: { title: "x" },
    tier: "write",
    tainted: false,
    sessionId: "win-GRANT",
  };
  const w = await requestApproval(
    { org: ORG, kind: EXECUTOR_OP_KIND, args: writeArgs, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQ", channelId: "C1", threadTs: null, postedTo: "slack/T1/C1" },
    { postCard },
  );
  const rw = await resolveApprovalClick({ org: ORG, id: w.id, decision: "approve_session", clickerId: "U_ADMIN" });
  ok(rw.outcome === "decided", "approve_session on a WRITE row decides it");
  ok(resumeCount === 1, "the WRITE was also published once (approve_session approves this one too)");
  const memo = await store.getSessionApproval(ORG, "win-GRANT", "connector.op:notion", new Date().toISOString());
  ok(memo?.grantedBy === "U_ADMIN", "approve_session WROTE the per-connector session memo, attributed to the clicker");

  const destArgs: ExecutorOpArgs = { ...writeArgs, op: "notion_delete_page", executionId: "exec_d", tier: "destructive", sessionId: "win-DEST" };
  const d = await requestApproval(
    { org: ORG, kind: EXECUTOR_OP_KIND, args: destArgs, scopeKey: "slack/T1/C1", domain: null, requestedBy: "U_REQ", channelId: "C1", threadTs: null, postedTo: "slack/T1/C1" },
    { postCard: async () => "ts-2" },
  );
  const rd = await resolveApprovalClick({ org: ORG, id: d.id, decision: "approve_session", clickerId: "U_ADMIN" });
  ok(rd.outcome === "decided", "approve_session on a DESTRUCTIVE row still decides (degrades to one-off approve)");
  ok(resumeCount === 2, "the DESTRUCTIVE op was published once");
  const noMemo = await store.getSessionApproval(ORG, "win-DEST", "connector.op:notion", new Date().toISOString());
  ok(noMemo === null, "approve_session on a DESTRUCTIVE row wrote NO session memo (kind-enforcement / destructive-never, in code)");

  resetExecutorTransportClient();
}

console.log(`✓ connector-approval-model: ${passed} assertions passed (tier + REST map + session-grant + destructive-per-call + skip/audit)`);
