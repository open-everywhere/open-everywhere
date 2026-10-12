import assert from "node:assert/strict";
import { linearMessageOps } from "../agent/channels/linear-message-ops.js";
import { registerLinearProvider } from "../agent/register.js";
import { surfaceMessageOps, friendlyGuardSource, isFriendlyGuarded } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SAVED_TOKEN = process.env.LINEAR_AGENT_ACCESS_TOKEN;
process.env.LINEAR_AGENT_ACCESS_TOKEN = "lin_test_token";
const savedFetch = globalThis.fetch;

interface Call {
  readonly query: string;
  readonly variables: unknown;
}

function stubGraphQL(table: ReadonlyArray<{ readonly match: RegExp; readonly data?: unknown; readonly errors?: Array<Record<string, unknown>> }>): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    calls.push({ query: body.query, variables: body.variables });
    const hit = table.find((t) => t.match.test(body.query));
    if (!hit) throw new Error(`stubGraphQL: no response configured for query starting: ${body.query.slice(0, 80)}`);
    return new Response(JSON.stringify({ ...(hit.data !== undefined ? { data: hit.data } : {}), ...(hit.errors ? { errors: hit.errors } : {}) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls };
}

try {
  {
    registerLinearProvider();
    const resolved = surfaceMessageOps("linear");
    ok(resolved !== undefined, "registerLinearProvider() makes surfaceMessageOps('linear') resolve to something (OPE-899 was: it resolved undefined)");
    ok(isFriendlyGuarded(resolved), "the registry stores the ops wrapped by the friendly-names guard (OPE-2482)");
    ok(friendlyGuardSource(resolved) === linearMessageOps, "…and it resolves to THIS module's ops object, by identity — the same one turn-anchor.ts's postSurfaceText/setSurfaceReaction dispatch to");
    ok(typeof resolved?.postText === "function" && typeof resolved?.editMessage === "function" && typeof resolved?.setReaction === "function", "the resolved ops carry postText/editMessage/setReaction");
    ok(resolved?.postFiles === undefined, "…and NO postFiles (the optional-tier ruling — Linear has no attach-a-file-to-a-comment mutation)");
  }

  {
    const { calls } = stubGraphQL([{ match: /OeSurfacePostText/, data: { commentCreate: { success: true, comment: { id: "cmt-1" } } } }]);
    const id = await linearMessageOps.postText("ISS-1", "hello");
    ok(id === "cmt-1", "postText returns the created comment id");
    ok((calls[0].variables as { input: { issueId: string; body: string; parentId?: string } }).input.issueId === "ISS-1", "targets the issue id (the SurfaceMessageOps channelId)");
    ok((calls[0].variables as { input: { parentId?: string } }).input.parentId === undefined, "no opts ⇒ no parentId (a plain post, not a threaded reply)");
  }
  {
    const { calls } = stubGraphQL([{ match: /OeSurfacePostText/, data: { commentCreate: { success: true, comment: { id: "cmt-2" } } } }]);
    await linearMessageOps.postText("ISS-1", "a reply", { replyToMessageId: "cmt-root" });
    ok((calls[0].variables as { input: { parentId?: string } }).input.parentId === "cmt-root", "opts.replyToMessageId threads through as parentId (a threaded reply)");
  }
  {
    stubGraphQL([{ match: /OeSurfacePostText/, data: { commentCreate: { success: true } } }]);
    await assert.rejects(() => linearMessageOps.postText("ISS-1", "hello"), /no success or no comment id/, "success with no comment id refuses loudly rather than returning an unusable empty id");
    n++;
  }

  {
    const { calls } = stubGraphQL([{ match: /OeSurfaceEditMessage/, data: { commentUpdate: { success: true } } }]);
    await linearMessageOps.editMessage("ISS-1", "cmt-1", "edited text");
    ok((calls[0].variables as { id: string; input: { body: string } }).id === "cmt-1", "edits the given comment id");
    ok((calls[0].variables as { input: { body: string } }).input.body === "edited text", "carries the new body");
  }
  {
    stubGraphQL([{ match: /OeSurfaceEditMessage/, data: { commentUpdate: { success: false } } }]);
    await assert.rejects(() => linearMessageOps.editMessage("ISS-1", "cmt-1", "x"), /returned no success/, "a decided commentUpdate refusal (success:false) throws, never silently swallowed");
    n++;
  }

  {
    const { calls } = stubGraphQL([{ match: /OeSurfaceReact/, data: { reactionCreate: { success: true } } }]);
    await linearMessageOps.setReaction!("ISS-1", "cmt-1", "raised_hand", true);
    ok(calls.length === 1, "add fires exactly one mutation (no lookup needed to ADD)");
    ok((calls[0].variables as { input: { commentId: string; emoji: string } }).input.commentId === "cmt-1", "targets the COMMENT id, not the issue — Linear's ReactionCreateInput.commentId");
    ok((calls[0].variables as { input: { emoji: string } }).input.emoji === "raised_hand", "carries the given emoji verbatim");
  }

  {
    const { calls } = stubGraphQL([
      { match: /OeViewer/, data: { viewer: { id: "app-user-1", name: "OE Bot" } } },
      {
        match: /OeSurfaceReactionLookup/,
        data: {
          comment: {
            reactions: {
              nodes: [
                { id: "rx-mine", emoji: "raised_hand", user: { id: "app-user-1" } },
                { id: "rx-theirs", emoji: "raised_hand", user: { id: "human-42" } },
              ],
            },
          },
        },
      },
      { match: /OeSurfaceUnreact/, data: { reactionDelete: { success: true } } },
    ]);
    await linearMessageOps.setReaction!("ISS-1", "cmt-1", "raised_hand", false);
    const deleteCall = calls.find((c) => /OeSurfaceUnreact/.test(c.query));
    ok(deleteCall !== undefined, "remove issues a reactionDelete");
    ok((deleteCall!.variables as { id: string }).id === "rx-mine", "deletes ONLY the app's OWN reaction id (rx-mine), never the member's (rx-theirs)");
  }
  {
    const { calls } = stubGraphQL([
      { match: /OeViewer/, data: { viewer: { id: "app-user-1", name: "OE Bot" } } },
      { match: /OeSurfaceReactionLookup/, data: { comment: { reactions: { nodes: [{ id: "rx-theirs", emoji: "raised_hand", user: { id: "human-42" } }] } } } },
    ]);
    await linearMessageOps.setReaction!("ISS-1", "cmt-1", "raised_hand", false);
    ok(calls.every((c) => !/OeSurfaceUnreact/.test(c.query)), "no app reaction found ⇒ no reactionDelete call (idempotent no-op, not an error)");
  }

  {
    globalThis.fetch = (async () => {
      throw new Error("simulated transport failure");
    }) as unknown as typeof fetch;
    let threw = false;
    try {
      await linearMessageOps.setReaction!("ISS-1", "cmt-1", "raised_hand", true);
    } catch {
      threw = true;
    }
    ok(threw === false, "setReaction swallows a transport failure on ADD rather than throwing (best-effort affordance beside live work)");
  }
  {
    globalThis.fetch = (async () => {
      throw new Error("simulated transport failure");
    }) as unknown as typeof fetch;
    let threw = false;
    try {
      await linearMessageOps.setReaction!("ISS-1", "cmt-1", "raised_hand", false);
    } catch {
      threw = true;
    }
    ok(threw === false, "setReaction swallows a transport failure on REMOVE rather than throwing");
  }
} finally {
  globalThis.fetch = savedFetch;
  if (SAVED_TOKEN === undefined) delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
  else process.env.LINEAR_AGENT_ACCESS_TOKEN = SAVED_TOKEN;
}

console.log(`✓ ${n} linear-message-ops assertions passed`);
