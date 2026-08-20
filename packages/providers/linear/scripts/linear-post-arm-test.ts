import assert from "node:assert/strict";
import { platformFailureClass } from "@open-everywhere/core/agent/adapter-api.js";
import { linearPostArm } from "../agent/channels/linear-post-arm.js";
import type { ReplyTarget, UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SAVED_TOKEN = process.env.LINEAR_AGENT_ACCESS_TOKEN;
process.env.LINEAR_AGENT_ACCESS_TOKEN = "lin_test_token";

function stubGraphQL(status: number, data?: unknown, errors?: Array<{ message: string }>): typeof fetch {
  return (async () => new Response(JSON.stringify({ ...(data !== undefined ? { data } : {}), ...(errors ? { errors } : {}) }), { status })) as unknown as typeof fetch;
}

const savedFetch = globalThis.fetch;

try {
  {
    const target: ReplyTarget = { platform: "linear", agentSessionId: "sess-1" };

    globalThis.fetch = stubGraphQL(200, { agentActivityCreate: { success: true, agentActivity: { id: "act-1" } } });
    const id = await linearPostArm.dispatchReply!(target, "hi");
    ok(id === "act-1", "success control: dispatchLinearReply returns the real activity id on a landed post");

    globalThis.fetch = stubGraphQL(200, { agentActivityCreate: { success: false } });
    let successFalseErr: unknown;
    try {
      await linearPostArm.dispatchReply!(target, "hi");
    } catch (err) {
      successFalseErr = err;
    }
    ok(successFalseErr instanceof Error, "success:false with no thrown error still THROWS from dispatchLinearReply (was previously silently swallowed)");
    ok(platformFailureClass(successFalseErr) === "definitive", "OPE-825: a decided success:false GraphQL refusal classifies DEFINITIVE");

    globalThis.fetch = stubGraphQL(403, undefined, [{ message: "not authorized" }]);
    let httpErr: unknown;
    try {
      await linearPostArm.dispatchReply!(target, "hi");
    } catch (err) {
      httpErr = err;
    }
    ok((httpErr as { status?: unknown } | undefined)?.status === 403, "a LinearApiError carries the real numeric status (403) — eve's own field, read without help");
    ok(platformFailureClass(httpErr) === "definitive", "OPE-825: a 403 LinearApiError classifies DEFINITIVE");

    globalThis.fetch = stubGraphQL(503, undefined, [{ message: "unavailable" }]);
    let ambiguousErr: unknown;
    try {
      await linearPostArm.dispatchReply!(target, "hi");
    } catch (err) {
      ambiguousErr = err;
    }
    ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-825: a 503 LinearApiError classifies AMBIGUOUS (fail-closed default)");
  }

  {
    const origin = { platform: "linear", issueId: "issue-1", ambient: true } as Extract<UnifiedWakeOrigin, { platform: "linear" }>;
    const deps = {} as UnifiedReplyDeps;

    globalThis.fetch = stubGraphQL(200, { commentCreate: { success: true } });
    const id = await linearPostArm.dispatchUnified!(origin, "hi", deps);
    ok(id === "comment", "success control: the ambient arm returns on a landed commentCreate");

    globalThis.fetch = stubGraphQL(200, { commentCreate: { success: false } });
    let successFalseErr: unknown;
    try {
      await linearPostArm.dispatchUnified!(origin, "hi", deps);
    } catch (err) {
      successFalseErr = err;
    }
    ok(platformFailureClass(successFalseErr) === "definitive", "OPE-825: ambient commentCreate success:false classifies DEFINITIVE");

    globalThis.fetch = stubGraphQL(403, undefined, [{ message: "not authorized" }]);
    let httpErr: unknown;
    try {
      await linearPostArm.dispatchUnified!(origin, "hi", deps);
    } catch (err) {
      httpErr = err;
    }
    ok(httpErr instanceof Error && /ambient commentCreate failed/.test((httpErr as Error).message), "the ambient arm re-wraps the transport error in its own token-free copy");
    ok(platformFailureClass(httpErr) === "definitive", "OPE-825: carryFailureSignals keeps the 403 DEFINITIVE across the ambient arm's re-wrap");

    globalThis.fetch = stubGraphQL(503, undefined, [{ message: "unavailable" }]);
    let ambiguousErr: unknown;
    try {
      await linearPostArm.dispatchUnified!(origin, "hi", deps);
    } catch (err) {
      ambiguousErr = err;
    }
    ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-825: a 503 stays AMBIGUOUS across the ambient arm's re-wrap (negative control)");
  }

  {
    const origin = { platform: "linear", issueId: "issue-2", agentSessionId: "sess-2" } as Extract<UnifiedWakeOrigin, { platform: "linear" }>;
    const deps = {} as UnifiedReplyDeps;

    globalThis.fetch = stubGraphQL(200, { agentActivityCreate: { success: true, agentActivity: { id: "act-2" } } });
    const id = await linearPostArm.dispatchUnified!(origin, "hi", deps);
    ok(id === "act-2", "success control: the mention arm returns the real activity id on a landed post");

    globalThis.fetch = stubGraphQL(200, { agentActivityCreate: { success: false } });
    let successFalseErr: unknown;
    try {
      await linearPostArm.dispatchUnified!(origin, "hi", deps);
    } catch (err) {
      successFalseErr = err;
    }
    ok(platformFailureClass(successFalseErr) === "definitive", "OPE-825: mention-arm response success:false classifies DEFINITIVE");

    globalThis.fetch = stubGraphQL(403, undefined, [{ message: "not authorized" }]);
    let httpErr: unknown;
    try {
      await linearPostArm.dispatchUnified!(origin, "hi", deps);
    } catch (err) {
      httpErr = err;
    }
    ok(platformFailureClass(httpErr) === "definitive", "OPE-825: carryFailureSignals keeps a 403 DEFINITIVE across the mention arm's re-wrap");

    globalThis.fetch = stubGraphQL(503, undefined, [{ message: "unavailable" }]);
    let ambiguousErr: unknown;
    try {
      await linearPostArm.dispatchUnified!(origin, "hi", deps);
    } catch (err) {
      ambiguousErr = err;
    }
    ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-825: a 503 stays AMBIGUOUS across the mention arm's re-wrap (negative control)");
  }

  {
    const target: ReplyTarget = { platform: "linear", agentSessionId: "sess-3" };
    globalThis.fetch = stubGraphQL(200, undefined, [{ message: "some internal error" }]);
    let err: unknown;
    try {
      await linearPostArm.dispatchReply!(target, "hi");
    } catch (e) {
      err = e;
    }
    ok((err as { status?: unknown } | undefined)?.status === 200, "a top-level GraphQL errors[] at HTTP 200 still carries status=200 on the thrown error");
    ok(platformFailureClass(err) === "ambiguous", "OPE-825 scope boundary: a 200+errors[] GraphQL response classifies AMBIGUOUS, not DEFINITIVE — deliberate, see comment above");
  }
  {
    type Bag = Parameters<NonNullable<typeof linearPostArm.resolveTarget>>[0];
    const bag = (fields: Record<string, string>): Bag =>
      ({ str: (k: string) => fields[k], num: () => undefined, ctx: {} as never }) as Bag;

    const both = linearPostArm.resolveTarget!(bag({ agentSessionId: "sess-9", issueId: "ISS9", parentId: "C1" }));
    assert.deepStrictEqual(both, { platform: "linear", agentSessionId: "sess-9" }, "route selection: an agent session wins where both routes resolve");
    const ambient = linearPostArm.resolveTarget!(bag({ issueId: "ISS9", parentId: "C1" }));
    assert.deepStrictEqual(ambient, { platform: "linear", issueId: "ISS9", parentId: "C1" }, "🔴 OPE-811: no agent session ⇒ the AMBIENT issue/thread target (the supervisor turn's route)");
    const rootless = linearPostArm.resolveTarget!(bag({ issueId: "ISS9" }));
    assert.deepStrictEqual(rootless, { platform: "linear", issueId: "ISS9" }, "an issue with no thread root resolves too — the comment lands top-level on the issue");
    ok(linearPostArm.resolveTarget!(bag({})) === null, "negative control: neither an agent session nor an issue ⇒ NO target — `reply` refuses rather than guessing");

    let sentQuery: string | undefined;
    let sentInput: { issueId?: string; parentId?: string; body?: string } | undefined;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: { input?: typeof sentInput } };
      sentQuery = parsed.query;
      sentInput = parsed.variables?.input;
      return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const ambientId = await linearPostArm.dispatchReply!({ platform: "linear", issueId: "ISS9", parentId: "C1" } as ReplyTarget, "the mid-turn answer");
    ok(sentQuery?.includes("commentCreate") === true, "🔴 OPE-811: the ambient target dispatches commentCreate, NOT an agent activity");
    ok(sentInput?.issueId === "ISS9" && sentInput?.parentId === "C1" && sentInput?.body === "the mid-turn answer", "OPE-811: it posts the text into the resolved issue + thread root");
    ok(typeof ambientId === "string" && ambientId.length > 0, "OPE-811: it returns a non-empty id — commentCreate selects only {success}, so the spine gets the fixed sentinel");

    globalThis.fetch = stubGraphQL(200, { commentCreate: { success: false } });
    let refused: unknown;
    try {
      await linearPostArm.dispatchReply!({ platform: "linear", issueId: "ISS9" } as ReplyTarget, "hi");
    } catch (err) {
      refused = err;
    }
    ok(refused instanceof Error, "negative control: a decided commentCreate refusal (success:false) THROWS rather than reporting a landed post");
    ok(platformFailureClass(refused) === "definitive", "OPE-825 parity: the ambient route's decided refusal classifies DEFINITIVE too");
  }

  {
    type ReactBag = Parameters<NonNullable<typeof linearPostArm.resolveReactTarget>>[0];
    const bag = (fields: Record<string, string>): ReactBag => ({ str: (k: string) => fields[k], num: () => undefined, ctx: {} as never }) as ReactBag;

    ok(typeof linearPostArm.resolveReactTarget === "function" && typeof linearPostArm.react === "function", "🔴 OPE-862: the linear arm implements the REACT pair");

    const both = linearPostArm.resolveReactTarget!(bag({ agentSessionId: "sess-9", issueId: "ISS9" }));
    assert.deepStrictEqual(both, { platform: "linear", issueId: "ISS9" }, "🔴 OPE-862: resolveReactTarget resolves the ISSUE even when an agent session is ALSO present — a react is never addressed to a session");
    ok(linearPostArm.resolveReactTarget!(bag({ agentSessionId: "sess-9" })) === null, "negative control: an agent session ALONE (no issueId) resolves NO react target — there is nothing reactionCreate could address");
    ok(linearPostArm.resolveReactTarget!(bag({})) === null, "negative control: neither field ⇒ NO react target");

    let sentQuery: string | undefined;
    let sentInput: { issueId?: string; emoji?: string } | undefined;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string; variables?: { input?: typeof sentInput } };
      sentQuery = parsed.query;
      sentInput = parsed.variables?.input;
      return new Response(JSON.stringify({ data: { reactionCreate: { success: true } } }), { status: 200 });
    }) as unknown as typeof fetch;
    await linearPostArm.react!(both as never, "thumbsup");
    ok(sentQuery?.includes("reactionCreate") === true, "react: dispatches the reactionCreate mutation");
    ok(sentInput?.issueId === "ISS9" && sentInput?.emoji === "thumbsup", "react: sends the resolved issue id and the emoji name UNCHANGED — Linear's vocabulary matches Slack's bare names directly");

    globalThis.fetch = stubGraphQL(200, { reactionCreate: { success: false } });
    let successFalseErr: unknown;
    try {
      await linearPostArm.react!(both as never, "eyes");
    } catch (err) {
      successFalseErr = err;
    }
    ok(successFalseErr instanceof Error, "react: a decided success:false refusal THROWS");
    ok(platformFailureClass(successFalseErr) === "definitive", "OPE-862/825: reactionCreate success:false classifies DEFINITIVE");

    globalThis.fetch = stubGraphQL(403, undefined, [{ message: "not authorized" }]);
    let httpErr: unknown;
    try {
      await linearPostArm.react!(both as never, "eyes");
    } catch (err) {
      httpErr = err;
    }
    ok((httpErr as { status?: unknown } | undefined)?.status === 403, "react: a LinearApiError carries the real numeric status");
    ok(platformFailureClass(httpErr) === "definitive", "OPE-862/825: a 403 reactionCreate classifies DEFINITIVE");

    globalThis.fetch = stubGraphQL(503, undefined, [{ message: "unavailable" }]);
    let ambiguousErr: unknown;
    try {
      await linearPostArm.react!(both as never, "eyes");
    } catch (err) {
      ambiguousErr = err;
    }
    ok(platformFailureClass(ambiguousErr) === "ambiguous", "OPE-862/825: a 503 reactionCreate classifies AMBIGUOUS (fail-closed default)");
  }
} finally {
  globalThis.fetch = savedFetch;
  if (SAVED_TOKEN === undefined) delete process.env.LINEAR_AGENT_ACCESS_TOKEN; else process.env.LINEAR_AGENT_ACCESS_TOKEN = SAVED_TOKEN;
}

assert.ok(passed > 0);
console.log(`✓ linear-post-arm: ${passed} assertions passed`);
