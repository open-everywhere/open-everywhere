import assert from "node:assert/strict";
import { fetchWorkspaceRoster, _resetWorkspaceRosterCache } from "../agent/channels/slack-events.js";
import { withPatchedFetch } from "./_fetch-test-utils.js";

process.env["SLACK_BOT_TOKEN"] = "xoxb-test-roster";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

type Member = { id?: string; name?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean; profile?: { display_name?: string; real_name?: string }; real_name?: string };

let calls = 0;
let pages: { members: Member[]; next?: string }[] = [];
let failWith: string | undefined;

const fakeUsersList = (async (input: unknown, init?: { body?: unknown }) => {
  const url = input instanceof URL ? input : new URL(String(input));
  const op = url.pathname.split("/").pop() ?? "";
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (op !== "users.list") return respond({ ok: false, error: `unmocked_op:${op}` });
  calls++;
  if (failWith) return respond({ ok: false, error: failWith });
  const cursor = new URLSearchParams(String(init?.body ?? "")).get("cursor") ?? "";
  const index = cursor ? Number(cursor) : 0;
  const page = pages[index] ?? { members: [] };
  return respond({ ok: true, members: page.members, response_metadata: { next_cursor: page.next ?? "" } });
}) as typeof fetch;

await withPatchedFetch(fakeUsersList, async () => {

function fresh(next: { pages?: typeof pages; failWith?: string }): void {
  _resetWorkspaceRosterCache();
  calls = 0;
  failWith = next.failWith;
  pages = next.pages ?? [];
}

{
  fresh({
    pages: [
      {
        members: [
          { id: "U1", name: "alice", profile: { real_name: "Alice Ashton", display_name: "alice" } },
          { id: "UBOT", name: "deploybot", is_bot: true, profile: { real_name: "Deploy Bot" } },
          { id: "UGONE", name: "leaver", deleted: true, profile: { real_name: "Old Colleague" } },
          { id: "USLACKBOT", name: "slackbot", profile: { real_name: "Slackbot" } },
          { id: "UAPP", name: "someapp", is_app_user: true },
          { id: "   ", name: "blank-id" },
        ],
        next: "1",
      },
      { members: [{ id: "U2", name: "bob", real_name: "Bob Brown" }] },
    ],
  });

  const roster = await fetchWorkspaceRoster();
  assert.deepEqual(
    roster.map((r) => r.nativeId).sort(),
    ["U1", "U2"],
    "walk: pages are followed to the end, and bots, app users, slackbot, deactivated accounts and blank ids are all dropped",
  );
  n++;
  ok(calls === 2, "walk: exactly one call per page — the cursor is followed, not re-requested");
  ok(roster.find((r) => r.nativeId === "U1")?.handle === "alice", "walk: the SELF-SET display name lands as `handle`");
  ok(roster.find((r) => r.nativeId === "U1")?.name === "Alice Ashton", "walk: the profile real name lands as `name`");
  ok(roster.find((r) => r.nativeId === "U2")?.name === "Bob Brown", "walk: a member with no profile block falls back to the top-level real_name");
  ok(roster.find((r) => r.nativeId === "U2")?.handle === undefined, "walk: no display name ⇒ no handle invented (the negative control)");
}

{
  fresh({ pages: [{ members: [{ id: "U1", name: "alice" }] }] });

  await fetchWorkspaceRoster();
  ok(calls === 1, "memo setup: the first search walks Slack");

  await fetchWorkspaceRoster();
  await fetchWorkspaceRoster();
  ok(calls === 1, "🔴 MEMO: three searches in one window cost ONE walk — `users.list` is Tier-2 and a walk is up to ten calls of it");

  _resetWorkspaceRosterCache();
  calls = 0;
  const [a, b, c] = await Promise.all([fetchWorkspaceRoster(), fetchWorkspaceRoster(), fetchWorkspaceRoster()]);
  ok(calls === 1, "🔴 MEMO: three CONCURRENT searches also cost one walk — a burst cannot multiply what the cache exists to collapse");
  ok(a.length === 1 && b.length === 1 && c.length === 1, "memo: every concurrent caller gets the same answer");

  pages = [{ members: [{ id: "U1", name: "alice" }, { id: "U_NEW", name: "newjoiner" }] }];
  ok((await fetchWorkspaceRoster()).length === 1, "memo: inside the window the roster is served from cache, so a new joiner is not yet visible");
  _resetWorkspaceRosterCache();
  const afterExpiry = await fetchWorkspaceRoster();
  ok(afterExpiry.length === 2 && afterExpiry.some((r) => r.nativeId === "U_NEW"), "🔴 MEMO: once the window ends the roster is re-read and the new joiner appears — the cache is a TTL, never permanent");
}

{
  fresh({ pages: [{ members: [{ id: "U1", name: "alice" }] }], failWith: "missing_scope" });

  ok((await fetchWorkspaceRoster()).length === 0, "failure: a refused users.list resolves to an EMPTY roster, never a throw — linking falls back to the code flow");
  ok(calls === 1, "failure setup: the refusal cost one call");

  failWith = undefined;
  const retried = await fetchWorkspaceRoster();
  ok(calls === 2, "🔴 FAILURE IS NOT CACHED: the next search retries rather than serving a remembered empty roster");
  ok(retried.length === 1, "failure: the retry sees the real roster once the call succeeds");

  fresh({ pages: [{ members: [] }] });
  await fetchWorkspaceRoster();
  await fetchWorkspaceRoster();
  ok(calls === 2, "failure: a successful-but-empty roster is not cached either — only a non-empty answer is a fact worth holding");
}

});
console.log(`✓ slack-workspace-roster: ${n} assertions (paged walk + non-human filtering, the TTL memo and its concurrency collapse, failure never cached)`);
