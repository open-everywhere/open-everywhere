import assert from "node:assert/strict";
import { setLinearIssueState, assignLinearIssue, addLinearIssueLabel, linearEntityAdapter } from "../agent/channels/linear-actions.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

interface Call {
  readonly query: string;
  readonly variables: unknown;
}

function fakeLinearApi(table: ReadonlyArray<{ readonly match: RegExp; readonly data: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = (async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: unknown };
    calls.push({ query: body.query, variables: body.variables });
    const hit = table.find((t) => t.match.test(body.query));
    if (!hit) throw new Error(`fakeLinearApi: no response configured for query starting: ${body.query.slice(0, 80)}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: hit.data }) };
  }) as unknown as typeof fetch;
  return { api: { fetch: fetchFn }, credentials: { accessToken: "test-token" }, calls };
}

{
  const { api, credentials, calls } = fakeLinearApi([
    { match: /OeIssueTeamStates/, data: { issue: { team: { states: { nodes: [{ id: "s1", name: "Todo" }, { id: "s2", name: "Done" }] } } } } },
    { match: /OeSetIssueState/, data: { issueUpdate: { success: true } } },
  ]);
  const outcome = await setLinearIssueState("ENG-42", "done", { api, credentials });
  ok(outcome.includes("ENG-42") && outcome.includes('"Done"'), `resolves the real-cased state name in the outcome (${outcome})`);
  ok(calls.length === 2, "one states-lookup query + one issueUpdate mutation");
  ok((calls[1].variables as { stateId: string }).stateId === "s2", "the mutation uses the RESOLVED state id, not the input name");
  ok((calls[1].variables as { id: string }).id === "ENG-42", "the mutation targets the given issue ref");
}
{
  const { api, credentials } = fakeLinearApi([
    { match: /OeIssueTeamStates/, data: { issue: { team: { states: { nodes: [{ id: "s1", name: "Todo" }] } } } } },
  ]);
  await assert.rejects(
    () => setLinearIssueState("ENG-42", "Bogus State", { api, credentials }),
    /no state named "Bogus State".*available: Todo/s,
    "an unmatched state name refuses, listing the real options",
  );
  n++;
}
{
  const { api, credentials } = fakeLinearApi([{ match: /OeIssueTeamStates/, data: { issue: null } }]);
  await assert.rejects(() => setLinearIssueState("ENG-999", "Done", { api, credentials }), /not found or not visible/, "a null issue (not shared with the token) refuses loudly");
  n++;
}

{
  const { api, credentials, calls } = fakeLinearApi([{ match: /OeAssignIssue/, data: { issueUpdate: { success: true } } }]);
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const outcome = await assignLinearIssue("ENG-42", uuid, { api, credentials });
  ok(outcome.includes(uuid), "outcome names the assignee");
  ok(calls.length === 1, "a literal UUID assignee skips the user-resolution query entirely");
  ok((calls[0].variables as { assigneeId: string }).assigneeId === uuid, "the UUID passes straight through as assigneeId");
}
{
  const { api, credentials, calls } = fakeLinearApi([
    { match: /OeFindUser/, data: { users: { nodes: [{ id: "u1", email: "alice@acme.com", name: "Alice", displayName: "Alice A" }, { id: "u2", email: "bob@acme.com", name: "Bob" }] } } },
    { match: /OeAssignIssue/, data: { issueUpdate: { success: true } } },
  ]);
  const outcome = await assignLinearIssue("ENG-42", "ALICE@ACME.COM", { api, credentials });
  ok(outcome.includes("ALICE@ACME.COM"), "outcome echoes the given assignee string");
  ok(calls.length === 2, "a non-UUID assignee resolves via the users query, then mutates");
  ok((calls[1].variables as { assigneeId: string }).assigneeId === "u1", "resolves to the matched user's id");
}
{
  const { api, credentials } = fakeLinearApi([{ match: /OeFindUser/, data: { users: { nodes: [{ id: "u1", email: "alice@acme.com" }] } } }]);
  await assert.rejects(() => assignLinearIssue("ENG-42", "nobody@acme.com", { api, credentials }), /no workspace user matches/, "an unmatched assignee refuses (never guesses)");
  n++;
}
{
  const { api, credentials } = fakeLinearApi([
    { match: /OeFindUser/, data: { users: { nodes: [{ id: "u1", name: "Alice", email: "a@x.com" }, { id: "u2", displayName: "Alice", email: "b@x.com" }] } } },
  ]);
  await assert.rejects(() => assignLinearIssue("ENG-42", "Alice", { api, credentials }), /ambiguous/, "2+ matches on the same name refuses as ambiguous rather than picking one");
  n++;
}

{
  const { api, credentials, calls } = fakeLinearApi([
    { match: /OeIssueTeamLabels/, data: { issue: { team: { labels: { nodes: [{ id: "l1", name: "bug" }, { id: "l2", name: "P1" }] } } } } },
    { match: /OeAddIssueLabel/, data: { issueAddLabel: { success: true } } },
  ]);
  const outcome = await addLinearIssueLabel("ENG-42", "BUG", { api, credentials });
  ok(outcome.includes('"bug"') && outcome.includes("ENG-42"), `outcome names the real-cased label (${outcome})`);
  ok((calls[1].variables as { labelId: string }).labelId === "l1", "the mutation uses the resolved label id");
}
{
  const { api, credentials } = fakeLinearApi([{ match: /OeIssueTeamLabels/, data: { issue: { team: { labels: { nodes: [{ id: "l1", name: "bug" }] } } } } }]);
  await assert.rejects(() => addLinearIssueLabel("ENG-42", "nonexistent", { api, credentials }), /no label named "nonexistent".*available: bug/s, "an unmatched label refuses, listing the real options");
  n++;
}

{
  ok(linearEntityAdapter.platform === "linear", "adapter declares platform=linear");
  ok(typeof linearEntityAdapter.setState === "function", "adapter declares setState");
  ok(typeof linearEntityAdapter.assign === "function", "adapter declares assign");
  ok(typeof linearEntityAdapter.addLabel === "function", "adapter declares addLabel");
  ok(typeof linearEntityAdapter.checkAccess === "function", "Linear DECLARES checkAccess — the domain write fence (OPE-241); one workspace token bounds the workspace, never the domain");
}

console.log(`✓ ${n} linear-actions assertions passed`);
