import assert from "node:assert/strict";
import { githubCommentIsMachine, parseGitHubStopComment, routeGitHubStopComment, type GitHubStopDeps } from "../agent/channels/github-stop.js";
import { bindGitHub, buildGitHubAuth, githubConversationKey } from "../agent/channels/github-identity.js";
import { isStopDirective, type CancelAnchoredTurnInput, type CancelResult } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function commentDelivery(over: { body?: string; action?: string; userType?: string; login?: string } = {}): string {
  return JSON.stringify({
    action: over.action ?? "created",
    issue: { number: 42, title: "A thing" },
    comment: { id: 9001, body: over.body ?? "stop", user: { login: over.login ?? "a-person", type: over.userType ?? "User" } },
    repository: { name: "widgets", private: true, owner: { login: "acme" } },
    sender: { login: over.login ?? "a-person" },
  });
}

function recordingDeps(): { deps: GitHubStopDeps; calls: CancelAnchoredTurnInput[] } {
  const calls: CancelAnchoredTurnInput[] = [];
  return {
    calls,
    deps: {
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      cancel: async (input: CancelAnchoredTurnInput): Promise<CancelResult> => {
        calls.push(input);
        return { outcome: "requested", message: "Standing down — I've asked this turn to stop. I'll post the outcome in the thread." };
      },
    },
  };
}

{
  ok(isStopDirective("stop"), "`stop` is a stop directive");
  ok(isStopDirective("STOP"), "case does not matter");
  ok(isStopDirective("  stop \n"), "surrounding whitespace does not matter");
  ok(isStopDirective("stop."), "one trailing full stop is allowed");
  ok(isStopDirective("/oe stop"), "the `/oe stop` spelling matches, mirroring the slash command");

  ok(!isStopDirective("please stop"), "`please stop` is a MESSAGE, not a directive");
  ok(!isStopDirective("stop, that's the wrong repo"), "a stop word inside a sentence is a MESSAGE");
  ok(!isStopDirective("stopped"), "`stopped` is not `stop`");
  ok(!isStopDirective("@oe-bot stop"), "🔴 no @mention spelling — a mention opens a native session, so the ingress would cancel and re-start in one breath");
  ok(!isStopDirective(""), "an empty body is not a directive");
  ok(!isStopDirective(undefined), "a missing body is not a directive");
}

{
  const stop = parseGitHubStopComment(commentDelivery(), "issue_comment");
  ok(stop !== null, "a bare `stop` issue comment parses as a directive");
  ok(stop?.owner === "acme" && stop?.repo === "widgets" && stop?.number === 42, "…resolving owner, repo and the conversation number");
  ok(stop?.authorLogin === "a-person", "…and who asked");
  ok(stop?.repoPrivate === true, "…and the repo's privacy, which the partition binds on");

  ok(parseGitHubStopComment(commentDelivery({ body: "please stop" }), "issue_comment") === null, "a sentence containing `stop` is NOT a directive");
  ok(parseGitHubStopComment(commentDelivery({ action: "edited" }), "issue_comment") === null, "an EDIT into `stop` never triggers — the affordance is not retro-triggerable");
  ok(parseGitHubStopComment(commentDelivery(), "issues") === null, "an `issues` event carries no comment — never a directive");
  ok(parseGitHubStopComment(commentDelivery(), "push") === null, "a push is never a directive");
  ok(parseGitHubStopComment("not json", "issue_comment") === null, "an unparseable body yields null, never a throw");

  const review = parseGitHubStopComment(
    JSON.stringify({
      action: "created",
      pull_request: { number: 7 },
      comment: { body: "stop", user: { login: "a-person", type: "User" } },
      repository: { name: "widgets", owner: { login: "acme" } },
    }),
    "pull_request_review_comment",
  );
  ok(review?.number === 7, "a PR REVIEW comment resolves its number from `pull_request`");
}

{
  ok(githubCommentIsMachine({ user: { login: "oe-bot[bot]", type: "User" } }), "a `[bot]` login is a machine, whatever the type says");
  ok(githubCommentIsMachine({ user: { login: "oe-bot", type: "Bot" } }), "a `Bot` type is a machine, whatever the login says");
  ok(githubCommentIsMachine({}), "an UNRESOLVABLE author counts as a machine (fail-closed)");
  ok(!githubCommentIsMachine({ user: { login: "a-person", type: "User" } }), "negative control: a person is not a machine");

  ok(parseGitHubStopComment(commentDelivery({ userType: "Bot" }), "issue_comment") === null, "the AGENT's own `stop` comment never cancels (no self-cancel)");
  ok(parseGitHubStopComment(commentDelivery({ login: "oe-bot[bot]" }), "issue_comment") === null, "a `[bot]` author's `stop` comment never cancels");
  ok(parseGitHubStopComment(commentDelivery(), "issue_comment") !== null, "negative control: the SAME comment from a person DOES parse");
}

{
  const { deps, calls } = recordingDeps();
  const out = await routeGitHubStopComment(parseGitHubStopComment(commentDelivery(), "issue_comment")!, deps);
  ok(out.stopped === true, "a human `stop` comment CANCELS");
  ok(calls.length === 1, "…through exactly one cancelAnchoredTurn call");
  const call = calls[0]!;
  ok(call.platform === "github", "…stamped platform github");
  ok(call.via === "reaction", "…stamped via: reaction — the affordance CLASS, the same door as a Slack ✋");
  ok(call.requestedBy === "a-person", "…naming the person who asked");
  ok(call.query.channelKey === "github:acme/widgets#42", "…keyed on the issue/PR conversation");
  ok(call.query.anchorKey === undefined, "…and offering NO anchorKey: a comment id is not the turn's anchor message, so that lookup would always miss");
}

{
  const bound = bindGitHub({
    session: {
      auth: {
        current: buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "a-person", issueNumber: 42, isPrivate: true }),
      },
    },
  });
  assert.equal(bound.anchorChannelId, "acme/widgets#42");
  ok(bound.anchorChannelId === "acme/widgets#42", "bindGitHub stows the CONVERSATION key as the stop registry's container id");

  const { deps, calls } = recordingDeps();
  await routeGitHubStopComment(parseGitHubStopComment(commentDelivery(), "issue_comment")!, deps);
  ok(calls[0]!.query.channelKey === `github:${bound.anchorChannelId}`, "🔴 the webhook's key and the binding's key are BYTE-EQUAL — one derivation, two callers");

  const pr = bindGitHub({
    session: {
      auth: {
        current: buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "a-person", pullRequestNumber: 7, conversationKind: "pull_request" }),
      },
    },
  });
  ok(pr.anchorChannelId === "acme/widgets#7", "a PR turn anchors on its PR number");

  ok(githubConversationKey("acme", "widgets", undefined) === undefined, "a missing number yields NO key — a partial key would collide across repos");
  ok(githubConversationKey(undefined, "widgets", 1) === undefined, "a missing owner yields NO key");

  const noAnchor = bindGitHub({ session: { auth: { current: buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "a-person" }) } } });
  ok(noAnchor.anchorChannelId === undefined, "a turn with no issue or PR number contributes NO container id — never a guess");
}

{
  process.env.OE_ALLOW_UNVERIFIED_GITHUB_WEBHOOK = "1";
  const channel = (await import("../agent/channels/github.js")).default;
  type WebhookHandler = (req: Request, args: unknown) => Promise<Response>;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/github") as
    | { handler: WebhookHandler }
    | undefined;
  ok(route !== undefined, "(precondition) the github channel exposes its webhook route");

  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = () => undefined;

  async function drive(body: string): Promise<void> {
    const waited: Promise<unknown>[] = [];
    const args = {
      waitUntil: (p: Promise<unknown>) => void waited.push(p),
      attachSession: () => ({ cancel: async () => ({ status: "accepted" }) }),
      to: undefined,
      from: undefined,
    };
    const req = new Request("https://example.test/eve/v1/github", {
      method: "POST",
      headers: { "x-github-event": "issue_comment", "content-type": "application/json" },
      body,
    });
    await route!.handler(req, args).catch(() => undefined);
    await Promise.allSettled(waited);
  }

  let stopRun = 0;
  let ordinaryRun = 0;
  try {
    await drive(commentDelivery());
    stopRun = lines.filter((l) => l.includes("stop comment on acme/widgets#42")).length;
    lines.length = 0;
    await drive(commentDelivery({ body: "please stop, wrong repo" }));
    ordinaryRun = lines.filter((l) => l.includes("stop comment on")).length;
  } finally {
    console.log = realLog;
    console.error = realError;
    delete process.env.OE_ALLOW_UNVERIFIED_GITHUB_WEBHOOK;
  }
  ok(stopRun === 1, "🔴 REACHABILITY: the real webhook route runs the stop leg on a bare `stop` comment");
  ok(ordinaryRun === 0, "negative control: an ordinary comment runs NO stop leg");
}

console.log(`\n✓ github-stop: ${passed} assertions passed (the narrow directive grammar, the delivery parse across both comment families, the fail-closed author guard with negative controls, the cancel key, the one shared conversation-key derivation, and route reachability)`);
