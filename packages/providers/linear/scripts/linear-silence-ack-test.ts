import assert from "node:assert/strict";
import { LINEAR_SILENCE_ACK_BODY, LINEAR_ANSWERED_ACK_BODY, postLinearSilenceAck, postLinearAnsweredAck } from "../agent/channels/linear-silence-ack.js";
import { linearPostArm } from "../agent/channels/linear-post-arm.js";
import type { UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

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
const savedFetch = globalThis.fetch;

interface ActivityInput {
  readonly agentSessionId?: string;
  readonly content?: { readonly type?: string; readonly body?: string };
  readonly ephemeral?: boolean;
  readonly signal?: string;
}
let sent: ActivityInput[] = [];

function stubLinear(opts: { success?: boolean } = {}): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { variables?: { input?: ActivityInput } };
    const input = parsed.variables?.input ?? {};
    sent.push(input);
    if (input.signal !== undefined && input.content?.type !== "prompt") {
      return new Response(
        JSON.stringify({ errors: [{ message: `Signal "${input.signal}" is only allowed for prompt type activities.`, extensions: { code: "INPUT_ERROR" } }] }),
        { status: 200 },
      );
    }
    if (input.ephemeral === true && input.content?.type === "error") {
      return new Response(JSON.stringify({ errors: [{ message: "Activity of type error cannot be ephemeral.", extensions: { code: "INPUT_ERROR" } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { agentActivityCreate: { success: opts.success ?? true, agentActivity: { id: "act-ack" } } } }), { status: 200 });
  }) as unknown as typeof fetch;
}

try {
  ok(LINEAR_SILENCE_ACK_BODY === "Noted — no response needed.", "🔴 OPE-884: the ack copy is pinned byte for byte (host copy, fixed)");
  ok(!/\{|\}|\$/.test(LINEAR_SILENCE_ACK_BODY), "OPE-884: the ack carries no interpolation — nothing from the turn can reach the issue through it");
  ok(LINEAR_ANSWERED_ACK_BODY === "Answered in the comments.", "🔴 OPE-922: the ANSWERED close copy is pinned byte for byte (host copy, fixed)");
  ok(!/\{|\}|\$/.test(LINEAR_ANSWERED_ACK_BODY), "OPE-922: the answered close carries no interpolation either");
  ok((LINEAR_ANSWERED_ACK_BODY as string) !== (LINEAR_SILENCE_ACK_BODY as string), "🔴 OPE-922: the two lines are DIFFERENT — collapsing them re-ships the contradiction this ticket fixed");
  ok(!/no response needed/i.test(LINEAR_ANSWERED_ACK_BODY), "🔴 OPE-922: the answered close never denies that an answer exists");

  {
    sent = [];
    globalThis.fetch = stubLinear();
    await postLinearSilenceAck("sess-ack-1", "org-1");
    ok(sent.length === 1, "OPE-884: the ack is exactly ONE activity");
    const a = sent[0]!;
    ok(a.agentSessionId === "sess-ack-1", "OPE-884: the ack addresses the session it was given");
    ok(a.content?.type === "response", "🔴 OPE-884: the ack is a `response` — the only activity type that both shows something and ENDS a Linear agent session");
    ok(a.content?.body === LINEAR_SILENCE_ACK_BODY, "OPE-884: the ack body is the fixed host copy");
    ok(a.signal === undefined, "🔴 OPE-884: NO `signal` — `stop` is a human-to-agent signal and the API refuses it on any non-`prompt` activity");
    ok(a.ephemeral === undefined, "🔴 OPE-884: NOT ephemeral — an ephemeral activity is transient and would leave the session `active`");
  }

  {
    sent = [];
    globalThis.fetch = stubLinear({ success: false });
    let refusal: unknown;
    try {
      await postLinearSilenceAck("sess-ack-2", "org-1");
    } catch (err) {
      refusal = err;
    }
    ok(refusal instanceof Error, "🔴 OPE-884: a `success:false` ack THROWS — a refused ack must never audit as a landed one");
    ok(String((refusal as Error).message).includes("sess-ack-2"), "OPE-884: the failure names the session, so an operator can find the hanging spinner");

    sent = [];
    globalThis.fetch = stubLinear();
    const { createLinearAgentActivity } = await import("eve/channels/linear");
    let signalRefusal: unknown;
    try {
      await createLinearAgentActivity({
        credentials: { accessToken: "lin_test_token" },
        activity: { agentSessionId: "sess-ack-3", content: { type: "thought", body: "(no reply)" }, ephemeral: true, signal: "stop" },
      });
    } catch (err) {
      signalRefusal = err;
    }
    ok(signalRefusal instanceof Error, "🔴 OPE-884: the stub REFUSES the old thought+stop close, exactly as the live API does — the shape this ticket deleted cannot come back green");
  }

  {
    const mention: UnifiedWakeOrigin = { platform: "linear", issueId: "issue-1", agentSessionId: "sess-ack-4", organizationId: "org-1" } as UnifiedWakeOrigin;
    sent = [];
    globalThis.fetch = stubLinear();
    await linearPostArm.closeUnifiedSilently!(mention, {} as UnifiedReplyDeps);
    ok(sent.length === 1 && sent[0]!.content?.body === LINEAR_SILENCE_ACK_BODY, "OPE-884: the DIVERTED unified route renders the SAME ack — one behaviour whichever route answered the member");
    ok(sent[0]!.content?.type === "response" && sent[0]!.signal === undefined, "OPE-884: the unified ack has the same accepted shape (a plain `response`, no signal)");

    const ambient: UnifiedWakeOrigin = { platform: "linear", issueId: "issue-2", ambient: true, organizationId: "org-1" } as UnifiedWakeOrigin;
    sent = [];
    globalThis.fetch = stubLinear();
    await linearPostArm.closeUnifiedSilently!(ambient, {} as UnifiedReplyDeps);
    ok(sent.length === 0, "🔴 OPE-884 negative control: an AMBIENT origin posts NOTHING — no session, no spinner, no ack");

    sent = [];
    globalThis.fetch = stubLinear({ success: false });
    let armErr: unknown;
    try {
      await linearPostArm.closeUnifiedSilently!(mention, {} as UnifiedReplyDeps);
    } catch (err) {
      armErr = err;
    }
    ok(armErr instanceof Error, "OPE-884: a refused ack THROWS out of the arm for the spine to record");
  }

  {
    sent = [];
    globalThis.fetch = stubLinear();
    await postLinearAnsweredAck("sess-ans-1", "org-1");
    ok(sent.length === 1, "OPE-922: the answered close is exactly ONE activity");
    const a = sent[0]!;
    ok(a.content?.body === LINEAR_ANSWERED_ACK_BODY, "OPE-922: …carrying the ANSWERED line");
    ok(a.content?.type === "response", "🔴 OPE-922: …as a `response` — the close still has to TERMINATE the session");
    ok(a.signal === undefined && a.ephemeral === undefined, "🔴 OPE-922: …with the same accepted shape (no `signal`, not ephemeral)");

    const mention2: UnifiedWakeOrigin = { platform: "linear", issueId: "issue-9", agentSessionId: "sess-ans-2", organizationId: "org-1" } as UnifiedWakeOrigin;
    sent = [];
    globalThis.fetch = stubLinear();
    await linearPostArm.closeUnifiedSilently!(mention2, {} as UnifiedReplyDeps, true);
    ok(sent.length === 1 && sent[0]!.content?.body === LINEAR_ANSWERED_ACK_BODY, "🔴 OPE-922: `answered:true` closes the session with the ANSWERED line, not the silence line");

    sent = [];
    globalThis.fetch = stubLinear();
    await linearPostArm.closeUnifiedSilently!(mention2, {} as UnifiedReplyDeps, false);
    ok(sent.length === 1 && sent[0]!.content?.body === LINEAR_SILENCE_ACK_BODY, "🔴 OPE-922 negative control: `answered:false` still renders OPE-884's SILENCE line — a genuinely silent turn is untouched");

    sent = [];
    globalThis.fetch = stubLinear();
    await linearPostArm.closeUnifiedSilently!(mention2, {} as UnifiedReplyDeps);
    ok(sent.length === 1 && sent[0]!.content?.body === LINEAR_SILENCE_ACK_BODY, "OPE-922: an OMITTED flag renders the silence line — the default is the old behaviour");

    const ambient2: UnifiedWakeOrigin = { platform: "linear", issueId: "issue-10", ambient: true, organizationId: "org-1" } as UnifiedWakeOrigin;
    sent = [];
    globalThis.fetch = stubLinear();
    await linearPostArm.closeUnifiedSilently!(ambient2, {} as UnifiedReplyDeps, true);
    ok(sent.length === 0, "OPE-922: an AMBIENT origin still posts NOTHING, answered or not");
  }

  console.log(`\n✓ linear-silence-ack: ${passed} assertions passed (both pinned host copies, the accepted activity shape, refusals that throw, and the unified seam with its ambient + silence negative controls)`);
} finally {
  globalThis.fetch = savedFetch;
  if (SAVED_TOKEN === undefined) delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
  else process.env.LINEAR_AGENT_ACCESS_TOKEN = SAVED_TOKEN;
}
