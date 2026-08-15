import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Approval, ApprovalContext, ApprovalStatus } from "eve/tools/approval";

const dir = join(tmpdir(), `open-everywhere-approval-dedupe-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_PLATFORM = "slack";
delete process.env.OE_ORG;

const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
  loadBlobHosting: () => ({ enabled: true }),
});

const { withDuplicateApprovalGuard, recordApprovalRaised, DUPLICATE_APPROVAL_WINDOW_MS, DUPLICATE_APPROVAL_KEY_PREFIX } = await import(
  "@open-everywhere/core/agent/access/approval-dedupe.js"
);
import type { HasEventSeen, MarkEventSeen } from "@open-everywhere/core/agent/access/approval-dedupe.js";

const requestOf = (approval: Approval): ((ctx: ApprovalContext) => ApprovalStatus | Promise<ApprovalStatus>) =>
  typeof approval === "function" ? approval : approval.request;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function makeFakeStore() {
  const rows = new Map<string, number>();
  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const markEventSeen: MarkEventSeen = async (org, key, atIso, ttlMs) => {
    const at = Date.parse(atIso);
    const mapKey = `${org}\x00${key}`;
    const prev = rows.get(mapKey);
    if (prev !== undefined && at - prev < ttlMs) return false;
    rows.set(mapKey, at);
    return true;
  };
  const hasEventSeen: HasEventSeen = async (org, key, atIso, ttlMs) => {
    const at = Date.parse(atIso);
    const mapKey = `${org}\x00${key}`;
    const prev = rows.get(mapKey);
    return prev !== undefined && at - prev < ttlMs;
  };
  return { now, advance, markEventSeen, hasEventSeen, size: () => rows.size };
}

const ctx = (over: Partial<{ sessionId: string; toolName: string; toolInput: unknown; turnId: string }> = {}): ApprovalContext =>
  ({
    session: {
      id: over.sessionId ?? "sess-1",
      auth: {} as never,
      turn: { id: over.turnId ?? "turn_0", sequence: 0 } as never,
    },
    callId: "call-1",
    toolName: over.toolName ?? "post_file",
    toolInput: over.toolInput ?? { files: [{ filename: "x.html" }] },
    approvedTools: new Set<string>(),
  }) as unknown as ApprovalContext;

async function simulateApprovalRaised(c: ApprovalContext, store: ReturnType<typeof makeFakeStore>): Promise<void> {
  await recordApprovalRaised(c.session.id, c.toolName, c.toolInput, { now: store.now, markEventSeen: store.markEventSeen });
}

{
  const store = makeFakeStore();
  const always = async (): Promise<ApprovalStatus> => "user-approval";
  const guarded = withDuplicateApprovalGuard(always, { now: store.now, hasEventSeen: store.hasEventSeen });

  const first = await guarded(ctx());
  ok(first === "user-approval", "1a. the FIRST ask for an action prompts (unchanged decision)");

  await simulateApprovalRaised(ctx(), store);

  const second = await guarded(ctx());
  ok(
    typeof second === "object" && second !== null && second.type === "denied",
    "1b. a SECOND identical ask, AFTER the raise is recorded, is DENIED, not a fresh card",
  );
  ok(
    typeof second === "object" && second !== null && typeof second.reason === "string" && second.reason.length > 0,
    "1c. the denial carries a human-readable reason",
  );

  const third = await guarded(ctx());
  ok(
    typeof third === "object" && third !== null && third.type === "denied",
    "1d. a THIRD identical ask is still denied (not a one-shot suppression)",
  );
}

{
  const store = makeFakeStore();
  const always = async (): Promise<ApprovalStatus> => "user-approval";
  const guarded = withDuplicateApprovalGuard(always, { now: store.now, hasEventSeen: store.hasEventSeen });

  await guarded(ctx());
  await simulateApprovalRaised(ctx(), store);

  const differentInput = await guarded(ctx({ toolInput: { files: [{ filename: "y.html" }] } }));
  ok(differentInput === "user-approval", "2a. different toolInput → prompts (not the same action)");

  const differentTool = await guarded(ctx({ toolName: "notion__create_page" }));
  ok(differentTool === "user-approval", "2b. different toolName → prompts (not the same action)");

  const differentSession = await guarded(ctx({ sessionId: "sess-2" }));
  ok(differentSession === "user-approval", "2c. different session → prompts (never cross-session)");
}

{
  const throwing: HasEventSeen = async () => {
    throw new Error("must not be called for a non-prompting decision");
  };
  const notApplicable = async (): Promise<ApprovalStatus> => "not-applicable";
  const denied = async (): Promise<ApprovalStatus> => ({ type: "denied", reason: "policy says no" });

  const guardedNA = withDuplicateApprovalGuard(notApplicable, { hasEventSeen: throwing });
  ok((await guardedNA(ctx())) === "not-applicable", "3a. not-applicable passes through untouched");

  const guardedDenied = withDuplicateApprovalGuard(denied, { hasEventSeen: throwing });
  const d = await guardedDenied(ctx());
  ok(typeof d === "object" && d !== null && d.type === "denied" && d.reason === "policy says no", "3b. an underlying denial passes through untouched (its own reason, not the guard's)");
}

{
  const throwing: HasEventSeen = async () => {
    throw new Error("dedupe store down");
  };
  const always = async (): Promise<ApprovalStatus> => "user-approval";
  const guarded = withDuplicateApprovalGuard(always, { hasEventSeen: throwing });
  const first = await guarded(ctx());
  const second = await guarded(ctx());
  ok(first === "user-approval" && second === "user-approval", "4a. store throws → fail-open: BOTH identical asks still prompt");

  const bareCtx = { toolInput: { files: [{ filename: "x.html" }] }, toolName: "post_file" } as unknown as ApprovalContext;
  const guardedReal = withDuplicateApprovalGuard(always);
  const r1 = await guardedReal(bareCtx);
  const r2 = await guardedReal(bareCtx);
  ok(r1 === "user-approval" && r2 === "user-approval", "4b. a ctx with no `session` fails open on BOTH calls (never throws, never suppresses)");
}

{
  const store = makeFakeStore();
  const always = async (): Promise<ApprovalStatus> => "user-approval";
  const guarded = withDuplicateApprovalGuard(always, { now: store.now, hasEventSeen: store.hasEventSeen });

  ok((await guarded(ctx())) === "user-approval", "5a. t0 → prompts");
  await simulateApprovalRaised(ctx(), store);

  store.advance(DUPLICATE_APPROVAL_WINDOW_MS - 1);
  const stillInside = await guarded(ctx());
  ok(typeof stillInside === "object" && stillInside !== null && stillInside.type === "denied", "5b. just inside the window → still denied");
  store.advance(2);
  const outside = await guarded(ctx());
  ok(outside === "user-approval", "5c. just past the window → prompts again (a deliberate later re-ask is not silenced forever)");
}

ok(DUPLICATE_APPROVAL_KEY_PREFIX.length > 0, "6a. the guard's dedupe key carries its own namespace prefix");

{
  const store = makeFakeStore();
  const always = async (): Promise<ApprovalStatus> => "user-approval";
  const guarded = withDuplicateApprovalGuard(always, { now: store.now, hasEventSeen: store.hasEventSeen });

  const attempt1 = await guarded(ctx());
  ok(attempt1 === "user-approval", "7a. attempt 1 evaluates the policy and prompts");
  ok(store.size() === 0, "7b. NOTHING is marked yet — the guard's ask-time check never writes");

  const recovered = await guarded(ctx());
  ok(recovered === "user-approval", "7c. the crash-recovery redelivery RE-ASKS — it is not silently denied for a card no one ever saw");
  ok(store.size() === 0, "7d. still nothing marked — two prompts with no raise recorded leave no trace");

  await simulateApprovalRaised(ctx(), store);
  ok(store.size() === 1, "7e. recordApprovalRaised is the ONLY thing that marks the fingerprint");

  const afterRaise = await guarded(ctx());
  ok(
    typeof afterRaise === "object" && afterRaise !== null && afterRaise.type === "denied",
    "7f. once the raise is recorded, a further identical ask IS denied — the guard's purpose stays intact",
  );
}

{
  const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
  registerDiscordProvider();
  const { resolveWindowGated } = await import("@open-everywhere/core/agent/access/window-gated.js");
  const postFile = await resolveWindowGated(
    (await import("@open-everywhere/core/agent/tools/post_file.js")).default,
    { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } } as never,
  );
  const approvalOf = (postFile as unknown as { approval: (ctx: ApprovalContext) => Promise<ApprovalStatus> | ApprovalStatus }).approval;

  const htmlOptIn = ctx({
    sessionId: "live-session-post-file",
    toolName: "post_file",
    toolInput: { files: [{ source: { path: "page.html" }, filename: "page.html" }] },
  });
  const first = await approvalOf(htmlOptIn);
  ok(first === "user-approval", "8a. post_file's live approval prompts on the first HTML-publish ask (org opted in to Blob hosting)");

  const repeatBeforeRaise = await approvalOf(htmlOptIn);
  ok(repeatBeforeRaise === "user-approval", "8b. against the REAL store, a repeat ask before recordApprovalRaised still prompts (no silent denial)");

  await recordApprovalRaised(htmlOptIn.session.id, htmlOptIn.toolName, htmlOptIn.toolInput);
  const second = await approvalOf(htmlOptIn);
  ok(
    typeof second === "object" && second !== null && second.type === "denied",
    "8c. post_file's live approval denies a second identical publish ask once the raise is recorded",
  );
  const image = ctx({
    sessionId: "live-session-post-file",
    toolName: "post_file",
    toolInput: { files: [{ source: { path: "shot.png" }, filename: "shot.png" }] },
  });
  ok((await approvalOf(image)) === "not-applicable", "8d. an ungated post_file call (image, not HTML) stays not-applicable — the guard never widens a gate");

  const { connectorApprovalPolicy } = await import("@open-everywhere/core/agent/connections/connector-auth.js");
  const policy = connectorApprovalPolicy();
  const writeCtx = ctx({ sessionId: "live-session-notion", toolName: "notion__create_page", toolInput: { title: "hello" } });
  const firstWrite = await policy(writeCtx);
  ok(firstWrite === "user-approval", "8f. connectorApprovalPolicy() (opTiering off → once()) prompts on the first write ask");

  await recordApprovalRaised(writeCtx.session.id, writeCtx.toolName, writeCtx.toolInput);
  const secondWrite = await policy(writeCtx);
  ok(
    typeof secondWrite === "object" && secondWrite !== null && secondWrite.type === "denied",
    "8g. connectorApprovalPolicy() denies a second identical write ask once the raise is recorded (the default-deployment path — opTiering ships OFF)",
  );

  const readCtx = ctx({ sessionId: "live-session-notion", toolName: "notion__search", toolInput: { query: "x" } });
  ok((await policy(readCtx)) === "user-approval", "8h. a DIFFERENT op in the same live session still prompts on its own first ask (per-fingerprint isolation, not per-session)");
}

{
  const { connectorApprovalPolicy } = await import("@open-everywhere/core/agent/connections/connector-auth.js");
  const { default: approvalRaisedHook } = await import("@open-everywhere/core/agent/hooks/approval-raised.js");
  const inputRequestedHandler = (
    approvalRaisedHook as unknown as {
      events: { "input.requested": (event: unknown, ctx: unknown) => Promise<void> };
    }
  ).events["input.requested"];

  const sessionId = "live-session-string-convergence";
  const toolName = "notion__create_page";
  const objectForm = { title: "hello", blocks: ["a", "b"] };
  const stringForm = JSON.stringify(objectForm);

  const hookCtx = { session: { id: sessionId, auth: {} as never, turn: {} as never } };
  const hookEvent = {
    data: {
      requests: [{ action: { callId: "call-string-form", input: stringForm, kind: "tool-call", toolName }, kind: "tool-approval" }],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn-string-convergence",
    },
  };
  await inputRequestedHandler(hookEvent, hookCtx as never);

  const policy = connectorApprovalPolicy();
  const askCtx = ctx({ sessionId, toolName, toolInput: objectForm });
  const decision = await policy(askCtx);
  ok(
    typeof decision === "object" && decision !== null && decision.type === "denied",
    "9a. a STRING-form raise and an OBJECT-form ask, for the SAME logical data, fingerprint identically — the guard fires",
  );

  const differentObject = ctx({ sessionId, toolName, toolInput: { title: "hello", blocks: ["a", "c"] } });
  ok((await policy(differentObject)) === "user-approval", "9b. a different object under the same session/tool still prompts (fingerprint is over the DATA, not a loose match)");
}

{
  const store = makeFakeStore();
  const always = async (): Promise<ApprovalStatus> => "user-approval";
  const guarded = withDuplicateApprovalGuard(always, { now: store.now, hasEventSeen: store.hasEventSeen });

  const attempt1 = await guarded(ctx({ turnId: "turn_7" }));
  ok(attempt1 === "user-approval", "10a. attempt 1 prompts, and eve emits input.requested for it");

  await simulateApprovalRaised(ctx({ turnId: "turn_7" }), store);
  ok(store.size() === 1, "10b. the mark is durable the instant the hook writes it — it never waits for the step to commit");

  const recovered = await guarded(ctx({ turnId: "turn_7" }));
  ok(
    typeof recovered === "object" && recovered !== null && recovered.type === "denied",
    "10c. the recovered attempt is DENIED even though its own turn raised the (now orphaned) card — the OPE-476 residual",
  );

  const laterTurn = await guarded(ctx({ turnId: "turn_8" }));
  ok(
    typeof laterTurn === "object" && laterTurn !== null && laterTurn.type === "denied",
    "10d. a LATER turn's identical ask is denied by the same rule — the guard is turn-blind by construction",
  );
  ok(store.size() === 1, "10e. neither read wrote anything — the ask-time check stays side-effect free");
}

{
  const store = makeFakeStore();
  const bare = async (): Promise<ApprovalStatus> => "user-approval";
  const wrappedBare = withDuplicateApprovalGuard(bare, { now: store.now, hasEventSeen: store.hasEventSeen });
  ok(typeof wrappedBare === "function", "11a. a bare policy function is wrapped into a bare policy function (shape preserved)");

  const store2 = makeFakeStore();
  let responderCalls = 0;
  let requestCalls = 0;
  const configuration = {
    request: async (c: ApprovalContext): Promise<ApprovalStatus> => {
      requestCalls += 1;
      return c.toolName === "sentinel__op" ? "not-applicable" : "user-approval";
    },
    response: async (): Promise<{ readonly status: "allowed" }> => {
      responderCalls += 1;
      return { status: "allowed" };
    },
  };
  const wrapped = withDuplicateApprovalGuard(configuration, { now: store2.now, hasEventSeen: store2.hasEventSeen });
  ok(typeof wrapped !== "function", "11b. a configuration is wrapped into a configuration, NOT flattened to a function");
  ok(
    typeof wrapped === "object" && wrapped !== null && typeof wrapped.request === "function",
    "11c. the wrapped configuration still exposes a callable `request` policy",
  );

  ok(
    typeof wrapped === "object" && wrapped !== null && (wrapped as typeof configuration).response === configuration.response,
    "11d. the configuration's `response` policy survives the wrap BY IDENTITY — flattening would drop the responder check silently",
  );
  ok(responderCalls === 0, "11e. wrapping does not invoke the response policy (negative control: it runs only when eve settles a card)");

  const request = requestOf(wrapped);
  ok((await request(ctx({ sessionId: "sess-cfg" }))) === "user-approval", "11f. a configuration's FIRST ask prompts, unchanged");
  ok(requestCalls === 1, "11f2. …and it was THIS configuration's own `request` that ran (call counted), not a substitute policy");
  await simulateApprovalRaised(ctx({ sessionId: "sess-cfg" }), store2);
  const secondCfg = await request(ctx({ sessionId: "sess-cfg" }));
  ok(
    typeof secondCfg === "object" && secondCfg !== null && secondCfg.type === "denied",
    "11g. a configuration's SECOND identical ask is DENIED — the guard reaches the request half of both shapes",
  );

  const other = await request(ctx({ sessionId: "sess-cfg", toolName: "notion__create_page" }));
  ok(other === "user-approval", "11h. a different action under the configuration shape still prompts (the guard did not become blanket-deny)");

  const sentinel = await request(ctx({ sessionId: "sess-cfg", toolName: "sentinel__op" }));
  ok(sentinel === "not-applicable", "11i. a non-prompting decision from the configuration's own request passes through untouched");
  ok(store2.size() === 1, "11j. the non-prompting decision never touched the store (negative control: only a genuine prompt is fingerprinted)");
}

rmSync(dir, { recursive: true, force: true });
console.log(
  `✓ approval-dedupe — ${passed} assertions (duplicate-card suppression, crash-recovery ordering, OPE-476 residual, no false dedup, fail-open, window expiry, string/object input convergence, live post_file + connector-auth wiring, both approval authoring shapes)`,
);
